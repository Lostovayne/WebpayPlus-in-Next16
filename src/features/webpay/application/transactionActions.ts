"use server";

import { env } from "@/shared/env";
import { redirect } from "next/navigation";
import { WebpayTransaction } from "../domain/Transaction";
import { transactionRepository } from "../infrastructure/PrismaTransactionRepository";
import {
  TransbankAlreadyProcessedError,
  TransbankGateway,
} from "../infrastructure/TransbankGateway";

// Lazy singleton — allows test mocking via __setGatewayForTesting
let gateway: InstanceType<typeof TransbankGateway> | null = null;

function getGateway(): InstanceType<typeof TransbankGateway> {
  if (!gateway) gateway = new TransbankGateway();
  return gateway;
}

/**
 * Test-only: inject a mock gateway. Resets after each test.
 * @internal — blocked in production to prevent gateway hijacking
 */
export async function __setGatewayForTesting(mock: InstanceType<typeof TransbankGateway>): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setGatewayForTesting is not allowed in production");
  }
  gateway = mock;
}

export async function __resetGatewayForTesting(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__resetGatewayForTesting is not allowed in production");
  }
  gateway = null;
}

// ─── Helper: buy_order seguro ────────────────────────────────────────────────

/**
 * Genera un buy_order único y seguro de máximo 26 caracteres.
 *
 * ¿Por qué no Date.now()?
 * Date.now() puede colisionar en milisegundos bajo carga concurrente.
 * Con 10 bytes de crypto tenemos 2^80 posibilidades → colisión prácticamente imposible.
 *
 * Formato: "BO" + 20 hex chars = 22 chars totales (bajo el límite de 26 de Transbank).
 */
function generateBuyOrder(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `BO${hex}`.toUpperCase();
}

// ─── Use Case 1: Iniciar Transacción ────────────────────────────────────────

/**
 * Crea una nueva transacción Webpay y redirige al formulario de pago.
 *
 * Orden de operaciones (no cambiar este orden):
 * 1. Generar entidad de dominio en estado INITIALIZED
 * 2. Persistir en BD ← ANTES de tocar la red
 * 3. Llamar a Transbank → obtener token + URL
 * 4. Guardar el token en BD
 * 5. Redirigir al usuario
 *
 * Si Transbank falla en el paso 3, la transacción queda en BD como FAILED
 * y tenemos trazabilidad. Sin el paso 2 perderíamos el registro completamente.
 */
export async function initiateTransactionAction(amount: number): Promise<never> {
  if (amount <= 0) throw new Error("Monto inválido: debe ser mayor a cero.");

  const transaction = WebpayTransaction.initialize(generateBuyOrder(), crypto.randomUUID(), amount);

  // Persistir ANTES de tocar red externa
  await transactionRepository.save(transaction);

  const returnUrl = `${env.NEXT_PUBLIC_APP_URL}/api/webpay/return`;
  let redirectTarget: string;

  try {
    const tbkResponse = await getGateway().createTransaction(
      transaction.props.buyOrder,
      transaction.props.sessionId,
      transaction.props.amount,
      returnUrl,
    );

    transaction.setToken(tbkResponse.token);
    await transactionRepository.save(transaction);

    redirectTarget = `${tbkResponse.url}?token_ws=${tbkResponse.token}`;
  } catch (err) {
    transaction.markAsFailed();
    await transactionRepository.save(transaction);
    throw new Error(`Fallo al inicializar Gateway de pago: ${String(err)}`);
  }

  // redirect() debe ir fuera del try/catch — Next.js lo implementa con una excepción interna
  redirect(redirectTarget);
}

// ─── Use Case 2: Confirmar Transacción ──────────────────────────────────────

/**
 * Confirma (commit) la transacción cuando el usuario regresa del banco.
 *
 * Escenarios que maneja:
 * A) Flujo normal → commit → guardar resultado autorizado o rechazado
 * B) 422 (doble clic / recarga) → fallback a getTransactionStatus → recuperar sin FAILED
 * C) Ya en estado terminal → idempotente, retorna estado actual sin llamar a Transbank
 */
export async function confirmTransactionAction(token: string) {
  const transaction = await transactionRepository.findByToken(token);
  if (!transaction) {
    throw new Error("Transacción no encontrada para el token proporcionado.");
  }

  // Idempotencia: estado terminal significa que ya fue procesada
  if (transaction.isTerminal) {
    return transaction.props;
  }

  try {
    const response = await getGateway().commitTransaction(token);

    if (response.status === "AUTHORIZED" && response.response_code === 0) {
      transaction.markAsAuthorized({
        authorizationCode: response.authorization_code,
        paymentTypeCode: response.payment_type_code,
        installmentsNumber: response.installments_number,
        installmentsAmount: response.installments_amount ?? undefined,
        responseCode: response.response_code,
        // Audit trail — datos de Transbank para reconciliation
        vci: response.vci ?? undefined,
        cardNumber: response.card_detail?.card_number?.slice(-4) || undefined,
        accountingDate: response.accounting_date ?? undefined,
        transactionDate: response.transaction_date,
      });
    } else {
      transaction.markAsRejected(response.response_code);
    }
  } catch (error) {
    if (error instanceof TransbankAlreadyProcessedError) {
      // El usuario recargó la página de éxito o hubo un doble envío.
      // 422 NO significa FAILED — significa "ya lo procesé antes".
      // Consultamos el estado real para recuperar lo que pasó.
      try {
        const status = await getGateway().getTransactionStatus(token);

        if (status.status === "AUTHORIZED" && status.response_code === 0) {
          transaction.markAsAuthorized({
            authorizationCode: status.authorization_code,
            paymentTypeCode: status.payment_type_code,
            installmentsNumber: status.installments_number,
            installmentsAmount: status.installments_amount ?? undefined,
            responseCode: status.response_code,
            // Audit trail — datos de Transbank para reconciliation
            vci: status.vci ?? undefined,
            cardNumber: status.card_detail?.card_number?.slice(-4) || undefined,
            accountingDate: status.accounting_date ?? undefined,
            transactionDate: status.transaction_date,
          });
        } else {
          transaction.markAsRejected(status.response_code);
        }
      } catch (statusError) {
        // getTransactionStatus also failed — mark as FAILED with observability
        console.error("[Webpay] Fallback getTransactionStatus failed after 422:", statusError);
        transaction.markAsFailed();
      }
    } else {
      // Error técnico real: red, timeout, configuración incorrecta
      transaction.markAsFailed();
    }
  }

  await transactionRepository.save(transaction);
  return transaction.props;
}

// ─── Use Case 3: Abortar por TBK_TOKEN ──────────────────────────────────────

/**
 * Maneja cuando el usuario presiona "Anular" en la pasarela Transbank.
 *
 * Transbank envía TBK_TOKEN + TBK_ORDEN_COMPRA + TBK_ID_SESION.
 * Usamos el buyOrder para encontrar la transacción en nuestra BD
 * (el TBK_TOKEN no es el token de pago, es un identificador del abandono).
 */
export async function abortTransactionAction(tbkToken: string, buyOrder: string): Promise<void> {
  // Transbank envía el buyOrder tanto en cancelaciones como en timeouts.
  // Buscamos y marcamos ABORTED de inmediato para no depender del Worker.
  // Si no encontramos la transacción, logueamos para trazabilidad — no es un error fatal.
  const transaction = await transactionRepository.findByBuyOrder(buyOrder);

  if (!transaction) {
    console.warn(
      `[Webpay] abortTransactionAction: buyOrder "${buyOrder}" no encontrado. TBK_TOKEN: ${tbkToken}`,
    );
    return;
  }

  // Solo transiciones válidas desde INITIALIZED — si ya está en estado terminal, no tocamos nada.
  if (transaction.isTerminal) return;

  transaction.markAsAbortedByClient(`TBK_TOKEN:${tbkToken.slice(0, 20)}`);
  await transactionRepository.save(transaction);
}

// ─── Use Case 4: Polling del Worker ─────────────────────────────────────────

/**
 * Exclusivo del Worker/Cron. Se ejecuta cada 5 minutos desde el endpoint
 * protegido /api/webpay/poll.
 *
 * Encuentra transacciones en INITIALIZED de más de 10 minutos y consulta
 * a Transbank por su estado real. Esto resuelve el caso donde el usuario
 * pagó pero perdió conexión antes de llegar al return URL.
 */
export async function pollStaleTransactionsAction(): Promise<{
  processed: number;
  authorized: number;
  rejected: number;
  failed: number;
}> {
  const stale = await transactionRepository.findStaleInitialized(10);

  let authorized = 0;
  let rejected = 0;
  let failed = 0;

  for (const transaction of stale) {
    const token = transaction.props.token;

    if (!token) {
      // Sin token nunca se redirigió al banco → fallo técnico en la creación
      transaction.markAsFailed();
      await transactionRepository.save(transaction);
      failed++;
      continue;
    }

    try {
      const status = await getGateway().getTransactionStatus(token);

      if (status.status === "AUTHORIZED" && status.response_code === 0) {
        transaction.markAsAuthorized({
          authorizationCode: status.authorization_code,
          paymentTypeCode: status.payment_type_code,
          installmentsNumber: status.installments_number,
          installmentsAmount: status.installments_amount ?? undefined,
          responseCode: status.response_code,
          // Audit trail — datos de Transbank para reconciliation
          vci: status.vci ?? undefined,
          cardNumber: status.card_detail?.card_number?.slice(-4) || undefined,
          accountingDate: status.accounting_date ?? undefined,
          transactionDate: status.transaction_date,
        });
        authorized++;
      } else if (status.response_code !== undefined) {
        transaction.markAsRejected(status.response_code);
        rejected++;
      } else {
        // Estado ambiguo — dejar para el próximo ciclo
        continue;
      }

      // Marcar como polled DESPUÉS de respuesta exitosa de Transbank
      transaction.markAsPolled();
      await transactionRepository.save(transaction);
    } catch {
      // Transbank no pudo responder — ¿lleva más de 7 días? → ya jamás se resolverá
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (transaction.props.createdAt < sevenDaysAgo) {
        transaction.markAsFailed();
        await transactionRepository.save(transaction);
        failed++;
      }
      // Si no, dejamos para el próximo ciclo del cron — polledAt NO se modifica
    }
  }

  return { processed: stale.length, authorized, rejected, failed };
}
