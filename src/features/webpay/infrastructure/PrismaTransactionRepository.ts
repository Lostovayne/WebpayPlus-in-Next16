import { prisma } from "@/shared/lib/prisma";
import { TransactionStatus, WebpayTransaction } from "../domain/Transaction";

/**
 * Repositorio de Infraestructura — PrismaTransactionRepository
 *
 * Su único trabajo: traducir entre el lenguaje del Dominio (WebpayTransaction)
 * y el lenguaje de la Base de Datos (Prisma/SQL).
 *
 * El Dominio no sabe que Prisma existe. Este repositorio es el intérprete.
 */
export class PrismaTransactionRepository {
  // ─── Persistencia ───────────────────────────────────────────────────────────

  async save(transaction: WebpayTransaction): Promise<void> {
    const d = transaction.props;

    await prisma.webpayTransaction.upsert({
      where: { id: d.id },
      create: {
        id: d.id,
        buyOrder: d.buyOrder,
        sessionId: d.sessionId,
        amount: d.amount,
        status: d.status,
        token: d.token,
        vci: d.vci,
        cardNumber: d.cardNumber,
        accountingDate: d.accountingDate,
        transactionDate: d.transactionDate,
        authCode: d.authCode,
        paymentTypeCode: d.paymentTypeCode,
        installmentsAmount: d.installmentsAmount,
        installmentsNumber: d.installmentsNumber,
        responseCode: d.responseCode,
        abortedReason: d.abortedReason,
        polledAt: d.polledAt,
      },
      update: {
        status: d.status,
        token: d.token,
        vci: d.vci,
        cardNumber: d.cardNumber,
        accountingDate: d.accountingDate,
        transactionDate: d.transactionDate,
        authCode: d.authCode,
        paymentTypeCode: d.paymentTypeCode,
        installmentsAmount: d.installmentsAmount,
        installmentsNumber: d.installmentsNumber,
        responseCode: d.responseCode,
        abortedReason: d.abortedReason,
        polledAt: d.polledAt,
      },
    });
  }

  // ─── Consultas ──────────────────────────────────────────────────────────────

  async findByToken(token: string): Promise<WebpayTransaction | null> {
    const record = await prisma.webpayTransaction.findUnique({ where: { token } });
    if (!record) return null;
    return this.toDomain(record);
  }

  async findByBuyOrder(buyOrder: string): Promise<WebpayTransaction | null> {
    const record = await prisma.webpayTransaction.findUnique({ where: { buyOrder } });
    if (!record) return null;
    return this.toDomain(record);
  }

  /**
   * Busca transacciones que llevan más de N minutos en estado INITIALIZED.
   *
   * El Worker de polling llama a esto cada 5 minutos para encontrar transacciones
   * donde el usuario pagó en el banco pero jamás regresó al return URL
   * (internet caído, teléfono muerto, pestaña cerrada, etc.).
   *
   * Filtra también las que ya fueron auditadas en los últimos 5 minutos
   * (polledAt) para no saturar la API de Transbank con llamadas redundantes.
   */
  async findStaleInitialized(olderThanMinutes: number): Promise<WebpayTransaction[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    // No re-auditar si ya fue revisada hace menos de 5 minutos
    const pollCutoff = new Date(Date.now() - 5 * 60 * 1000);

    const records = await prisma.webpayTransaction.findMany({
      where: {
        status: "INITIALIZED",
        createdAt: { lt: cutoff },
        OR: [{ polledAt: null }, { polledAt: { lt: pollCutoff } }],
      },
      orderBy: { createdAt: "asc" },
      take: 50, // Límite de seguridad: no procesar lotes infinitos
    });

    return records.map((r) => this.toDomain(r));
  }

  // ─── Mapper Privado ──────────────────────────────────────────────────────────

  /**
   * Convierte un registro de base de datos en una entidad de Dominio.
   * Este mapeo existe aquí, no en el Dominio, porque el Dominio no sabe
   * que los Decimals de Prisma necesitan .toNumber().
   */
  private toDomain(record: {
    id: string;
    buyOrder: string;
    sessionId: string;
    amount: { toNumber(): number };
    status: string;
    token: string | null;
    vci: string | null;
    cardNumber: string | null;
    accountingDate: string | null;
    transactionDate: Date | null;
    authCode: string | null;
    paymentTypeCode: string | null;
    installmentsAmount: { toNumber(): number } | null;
    installmentsNumber: number | null;
    responseCode: number | null;
    abortedReason: string | null;
    polledAt: Date | null;
    createdAt: Date;
  }): WebpayTransaction {
    // Runtime validation: ensure DB status is a valid domain status
    const validStatuses: readonly string[] = ["INITIALIZED", "AUTHORIZED", "REJECTED", "ABORTED", "FAILED", "REVERSED"];
    if (!validStatuses.includes(record.status)) {
      throw new Error(`Corrupted transaction status in DB: "${record.status}" for id=${record.id}`);
    }

    return new WebpayTransaction({
      id: record.id,
      buyOrder: record.buyOrder,
      sessionId: record.sessionId,
      amount: record.amount.toNumber(),
      status: record.status as TransactionStatus,
      token: record.token ?? undefined,
      vci: record.vci ?? undefined,
      cardNumber: record.cardNumber ?? undefined,
      accountingDate: record.accountingDate ?? undefined,
      transactionDate: record.transactionDate ?? undefined,
      authCode: record.authCode ?? undefined,
      paymentTypeCode: record.paymentTypeCode ?? undefined,
      installmentsAmount: record.installmentsAmount?.toNumber(),
      installmentsNumber: record.installmentsNumber ?? undefined,
      responseCode: record.responseCode ?? undefined,
      abortedReason: record.abortedReason ?? undefined,
      polledAt: record.polledAt ?? undefined,
      createdAt: record.createdAt,
    });
  }
}

export const transactionRepository = new PrismaTransactionRepository();
