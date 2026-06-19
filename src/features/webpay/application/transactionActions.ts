"use server";

import { env } from "@/shared/env";
import logger from "@/shared/lib/logger";
import { prisma } from "@/shared/lib/prisma";
import { redirect } from "next/navigation";
import { AuditEvent, Prisma } from "generated/prisma";
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

// ─── Audit Log Helper ──────────────────────────────────────────────────────

async function logAuditEvent(
  transactionId: string,
  buyOrder: string,
  event: AuditEvent,
  details?: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await prisma.transactionAuditLog.create({
      data: {
        transactionId,
        buyOrder,
        event,
        ...(details ? { details } : {}),
      },
    });
  } catch (err) {
    // Audit log failure must NOT break the transaction flow
    logger.error({ err, transactionId, buyOrder, event, tag: "audit_log_failed" }, "[Webpay] Failed to write audit log");
  }
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
export async function initiateTransactionAction(amount: number, idempotencyKey?: string): Promise<never> {
  if (amount <= 0) throw new Error("Monto inválido: debe ser mayor a cero.");

  // Idempotency: when a key is provided, use it directly as the buyOrder
  // so subsequent calls with the same key find the existing transaction.
  let buyOrder: string;

  if (idempotencyKey) {
    if (idempotencyKey.length > 26 || !/^[A-Za-z0-9_-]+$/.test(idempotencyKey)) {
      throw new Error("idempotencyKey inválido: máximo 26 caracteres alfanuméricos.");
    }
    buyOrder = idempotencyKey;

    const existing = await transactionRepository.findByBuyOrder(idempotencyKey);
    if (existing) {
      if (existing.props.status === "INITIALIZED" && existing.props.token && existing.props.paymentUrl) {
        // Re-use existing transaction — redirect to Transbank with stored URL
        await logAuditEvent(existing.props.id, buyOrder, "INITIALIZED", { idempotent: true } as Prisma.InputJsonValue);
        redirect(`${existing.props.paymentUrl}?token_ws=${existing.props.token}`);
      }
      if (existing.props.status === "INITIALIZED" && existing.props.token && !existing.props.paymentUrl) {
        // Token exists but paymentUrl missing (Transbank returned empty URL) — not redirectable
        throw new Error("Transacción en progreso, intenta de nuevo en unos segundos.");
      }
      if (existing.props.status === "INITIALIZED" && !existing.props.token) {
        throw new Error("Transacción en progreso, intenta de nuevo en unos segundos.");
      }
      // Terminal states — except FAILED, which is retryable
      // (FAILED = technical error on our side, Transbank was never called successfully)
      if (existing.isTerminal && existing.props.status !== "FAILED") {
        throw new Error("Transacción ya procesada.");
      }
      // FAILED status: fall through to create a new transaction (retry)
    }
  } else {
    buyOrder = generateBuyOrder();
  }

  const transaction = WebpayTransaction.initialize(buyOrder, crypto.randomUUID(), amount);

  // Persistir ANTES de tocar red externa.
  // Catch P2002 (unique constraint) for race condition: two parallel calls
  // with same idempotencyKey may both reach here. The second save will fail
  // with P2002 — re-read and apply idempotency logic.
  try {
    await transactionRepository.save(transaction);
  } catch (err) {
    // Prisma v7: error code is in err.code, NOT in err.message
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Race condition: another request created the transaction first.
      // Re-read and apply idempotency logic.
      const raceExisting = await transactionRepository.findByBuyOrder(buyOrder);
      if (raceExisting) {
        if (raceExisting.props.status === "INITIALIZED" && raceExisting.props.token && raceExisting.props.paymentUrl) {
          await logAuditEvent(raceExisting.props.id, buyOrder, "INITIALIZED", { idempotent: true } as Prisma.InputJsonValue);
          redirect(`${raceExisting.props.paymentUrl}?token_ws=${raceExisting.props.token}`);
        }
        // Terminal states (except FAILED) — cannot retry
        if (raceExisting.isTerminal && raceExisting.props.status !== "FAILED") {
          throw new Error("Transacción ya procesada.");
        }
        // INITIALIZED without token, or FAILED — retryable
      }
      throw new Error("Transacción en progreso, intenta de nuevo en unos segundos.");
    }
    throw err;
  }

  await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "INITIALIZED", { amount } as Prisma.InputJsonValue);

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
    transaction.setPaymentUrl(tbkResponse.url);
    await transactionRepository.save(transaction);

    redirectTarget = `${tbkResponse.url}?token_ws=${tbkResponse.token}`;
  } catch (err) {
    transaction.markAsFailed();
    await transactionRepository.save(transaction);
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: String(err) } as Prisma.InputJsonValue);
    throw new Error("Error al iniciar el pago. Intenta de nuevo más tarde.");
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
        cardNumber: response.card_detail?.card_number && response.card_detail.card_number.length >= 4 ? response.card_detail.card_number.slice(-4) : undefined,
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
            cardNumber: status.card_detail?.card_number && status.card_detail.card_number.length >= 4 ? status.card_detail.card_number.slice(-4) : undefined,
            accountingDate: status.accounting_date ?? undefined,
            transactionDate: status.transaction_date,
          });
        } else {
          transaction.markAsRejected(status.response_code);
        }
      } catch (statusError) {
        // getTransactionStatus also failed — mark as FAILED with observability
        logger.error({ err: statusError, token }, "[Webpay] Fallback getTransactionStatus failed after 422");
        transaction.markAsFailed();
      }
    } else {
      // Error técnico real: red, timeout, configuración incorrecta
      transaction.markAsFailed();
    }
  }

  await transactionRepository.save(transaction);

  // Audit log after state transition
  const newStatus = transaction.props.status;
  if (newStatus === "AUTHORIZED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "AUTHORIZED", {
      authorizationCode: transaction.props.authCode,
      responseCode: transaction.props.responseCode,
    } as Prisma.InputJsonValue);
  } else if (newStatus === "REJECTED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "REJECTED", {
      responseCode: transaction.props.responseCode,
    } as Prisma.InputJsonValue);
  } else if (newStatus === "FAILED") {
    await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED");
  }

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
export async function abortTransactionAction(tbkToken: string, buyOrder?: string): Promise<void> {
  // Transbank envía el buyOrder tanto en cancelaciones como en timeouts.
  // Buscamos y marcamos ABORTED de inmediato para no depender del Worker.
  // Si no encontramos la transacción, logueamos para trazabilidad — no es un error fatal.
  if (!buyOrder) {
    logger.warn({ tbkToken }, "[Webpay] abortTransactionAction: buyOrder not provided by Transbank");
    return;
  }
  const transaction = await transactionRepository.findByBuyOrder(buyOrder);

  if (!transaction) {
    logger.warn({ buyOrder, tbkToken }, "[Webpay] abortTransactionAction: buyOrder no encontrado");
    return;
  }

  // Solo transiciones válidas desde INITIALIZED — si ya está en estado terminal, no tocamos nada.
  if (transaction.isTerminal) return;

  transaction.markAsAbortedByClient(`TBK_TOKEN:${tbkToken.slice(0, 20)}`);
  await transactionRepository.save(transaction);
  await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "ABORTED", { tbkToken: tbkToken.slice(0, 20) } as Prisma.InputJsonValue);
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
      await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: "no_token" } as Prisma.InputJsonValue);
      failed++;
      continue;
    }

    try {
      const status = await getGateway().getTransactionStatus(token);

      // Race condition guard: re-read from DB after Transbank call.
      // The return handler may have already processed this transaction
      // while we were waiting for Transbank's response.
      const fresh = await transactionRepository.findByToken(token);
      if (fresh?.isTerminal) {
        // Already processed by return handler — skip silently
        continue;
      }

      if (status.status === "AUTHORIZED" && status.response_code === 0) {
        transaction.markAsAuthorized({
          authorizationCode: status.authorization_code,
          paymentTypeCode: status.payment_type_code,
          installmentsNumber: status.installments_number,
          installmentsAmount: status.installments_amount ?? undefined,
          responseCode: status.response_code,
          // Audit trail — datos de Transbank para reconciliation
          vci: status.vci ?? undefined,
          cardNumber: status.card_detail?.card_number && status.card_detail.card_number.length >= 4 ? status.card_detail.card_number.slice(-4) : undefined,
          accountingDate: status.accounting_date ?? undefined,
          transactionDate: status.transaction_date,
        });
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "AUTHORIZED", {
          authorizationCode: status.authorization_code,
          responseCode: status.response_code,
        } as Prisma.InputJsonValue);
        authorized++;
      } else if (status.response_code !== undefined) {
        transaction.markAsRejected(status.response_code);
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "REJECTED", {
          responseCode: status.response_code,
        } as Prisma.InputJsonValue);
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
      const referenceDate = transaction.props.transactionDate ?? transaction.props.createdAt;
      if (referenceDate < sevenDaysAgo) {
        transaction.markAsFailed();
        await transactionRepository.save(transaction);
        await logAuditEvent(transaction.props.id, transaction.props.buyOrder, "MARKED_FAILED", { reason: "stale_7d" } as Prisma.InputJsonValue);
        failed++;
      }
      // Si no, dejamos para el próximo ciclo del cron — polledAt NO se modifica
    }
  }

  return { processed: stale.length, authorized, rejected, failed };
}
