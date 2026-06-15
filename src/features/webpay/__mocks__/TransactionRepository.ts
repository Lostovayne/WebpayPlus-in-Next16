import { WebpayTransaction, TransactionStatus } from "../domain/Transaction";

/**
 * Mock del TransactionRepository para tests.
 *
 * Almacena transacciones en un Map en memoria.
 * No toca Prisma ni la base de datos.
 */
export class MockTransactionRepository {
  private store = new Map<string, WebpayTransaction>();

  async save(transaction: WebpayTransaction): Promise<void> {
    this.store.set(transaction.props.id, transaction);
  }

  async findByToken(token: string): Promise<WebpayTransaction | null> {
    for (const tx of this.store.values()) {
      if (tx.props.token === token) return tx;
    }
    return null;
  }

  async findByBuyOrder(buyOrder: string): Promise<WebpayTransaction | null> {
    for (const tx of this.store.values()) {
      if (tx.props.buyOrder === buyOrder) return tx;
    }
    return null;
  }

  async findStaleInitialized(olderThanMinutes: number): Promise<WebpayTransaction[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
    return Array.from(this.store.values()).filter(
      (tx) =>
        tx.props.status === "INITIALIZED" &&
        tx.props.createdAt < cutoff &&
        !tx.props.polledAt,
    );
  }

  // ─── Test Helpers ──────────────────────────────────────────────────────────

  /** Inserta una transacción directamente (sin pasar por save) */
  seed(transaction: WebpayTransaction): void {
    this.store.set(transaction.props.id, transaction);
  }

  /** Obtiene una transacción por ID (para assertions) */
  get(id: string): WebpayTransaction | undefined {
    return this.store.get(id);
  }

  /** Limpia todas las transacciones */
  clear(): void {
    this.store.clear();
  }

  /** Retorna todas las transacciones */
  all(): WebpayTransaction[] {
    return Array.from(this.store.values());
  }
}
