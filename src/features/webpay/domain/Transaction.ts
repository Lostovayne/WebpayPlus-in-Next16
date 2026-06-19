/**
 * Estados posibles de una transacción Webpay Plus.
 *
 * INITIALIZED  → Se creó y se redirigió al banco. Esperando retorno.
 * AUTHORIZED   → Transbank aprobó el cobro. Estado final positivo.
 * REJECTED     → Transbank rechazó el cobro (fondos insuficientes, etc).
 * ABORTED      → El usuario canceló manualmente en la pasarela (TBK_TOKEN).
 * FAILED       → Error técnico de nuestro sistema (no del banco).
 * REVERSED     → Fue revertido/anulado via Refund API después de autorizado.
 */
export type TransactionStatus =
  | "INITIALIZED"
  | "AUTHORIZED"
  | "REJECTED"
  | "ABORTED"
  | "FAILED"
  | "REVERSED";

export interface WebpayTransactionProps {
  id: string;
  buyOrder: string;
  sessionId: string;
  amount: number;
  status: TransactionStatus;
  token?: string;
  authCode?: string;
  paymentTypeCode?: string;
  installmentsAmount?: number;
  installmentsNumber?: number;
  responseCode?: number;
  // Audit trail — datos que Transbank retorna pero que antes se descartaban
  vci?: string;            // Verification Code Identifier — tipo de validación del pago
  cardNumber?: string;     // Últimos 4 dígitos de la tarjeta (para auditoría)
  accountingDate?: string; // Fecha contable "MMDD" de Transbank
  transactionDate?: Date;  // Fecha/hora real de la transacción
  abortedReason?: string;
  polledAt?: Date;
  paymentUrl?: string; // URL del formulario de Transbank — necesaria para redirect de idempotencia
  createdAt: Date;
}

/** Respuesta del commit/status de Transbank que el dominio necesita conocer. */
export interface WebpayCommitData {
  authorizationCode: string;
  paymentTypeCode: string;
  installmentsNumber: number;
  installmentsAmount?: number; // Puede no venir en transacciones de débito
  responseCode: number;
  // Audit trail — datos completos de Transbank para reconciliation
  vci: string;
  cardNumber?: string;       // Últimos 4 dígitos (puede no venir en algunos estados)
  accountingDate: string;    // "MMDD"
  transactionDate: string;   // ISO date string de Transbank
}

/**
 * Entidad de Dominio: Transacción Webpay.
 *
 * Máquina de estados explícita. Ninguna transición ilegal es posible.
 * La infraestructura (Prisma, HTTP) es un detalle de implementación ajeno a esta clase.
 */
export class WebpayTransaction {
  constructor(public readonly props: WebpayTransactionProps) {}

  // ─── Factory Method ───────────────────────────────────────────────────────

  public static initialize(buyOrder: string, sessionId: string, amount: number): WebpayTransaction {
    if (amount <= 0) {
      throw new Error("Monto de transacción inválido: debe ser mayor a cero.");
    }
    // Transbank Plus: límite máximo documentado para transacciones en CLP.
    if (amount > 999_999_999) {
      throw new Error("Monto de transacción inválido: supera el máximo de $999.999.999 CLP permitido por Transbank.");
    }
    if (buyOrder.length > 26) {
      throw new Error("buy_order supera los 26 caracteres permitidos por Transbank.");
    }


    return new WebpayTransaction({
      id: crypto.randomUUID(),
      buyOrder,
      sessionId,
      amount,
      status: "INITIALIZED",
      createdAt: new Date(),
    });
  }

  // ─── Transiciones de Estado ───────────────────────────────────────────────

  public setToken(token: string): void {
    this.assertStatus("INITIALIZED", "setToken");
    this.props.token = token;
  }

  public setPaymentUrl(url: string): void {
    this.assertStatus("INITIALIZED", "setPaymentUrl");
    if (!url) throw new Error("[Domain] paymentUrl no puede estar vacío.");
    this.props.paymentUrl = url;
  }

  public markAsAuthorized(data: WebpayCommitData): void {
    this.assertStatus("INITIALIZED", "markAsAuthorized");

    // Validar ANTES de mutar el estado — si algo falla, la transacción queda en INITIALIZED
    if (data.cardNumber !== undefined && data.cardNumber.length > 4) {
      throw new Error(`[Domain] cardNumber debe ser máximo 4 dígitos (PCI DSS). Recibido: ${data.cardNumber.length} caracteres.`);
    }
    const parsedDate = new Date(data.transactionDate);
    if (isNaN(parsedDate.getTime())) {
      throw new Error(`[Domain] transactionDate inválida de Transbank: "${data.transactionDate}". Auditar manualmente.`);
    }

    // Validaciones pasan → ahora sí mutar el estado
    this.props.status = "AUTHORIZED";
    this.props.authCode = data.authorizationCode;
    this.props.paymentTypeCode = data.paymentTypeCode;
    this.props.installmentsNumber = data.installmentsNumber;
    this.props.installmentsAmount = data.installmentsAmount;
    this.props.responseCode = data.responseCode;
    // Audit trail — campos de Transbank para reconciliation contable
    // Normalizar empty strings a undefined para consistencia en BD
    this.props.vci = data.vci || undefined;
    this.props.accountingDate = data.accountingDate || undefined;
    this.props.cardNumber = data.cardNumber || undefined;
    this.props.transactionDate = parsedDate;
  }

  public markAsRejected(responseCode?: number): void {
    this.assertStatus("INITIALIZED", "markAsRejected");
    this.props.status = "REJECTED";
    this.props.responseCode = responseCode;
  }

  public markAsAbortedByClient(reason: string): void {
    this.assertStatus("INITIALIZED", "markAsAbortedByClient");
    this.props.status = "ABORTED";
    this.props.abortedReason = reason.slice(0, 50);
  }

  public markAsFailed(): void {
    // CRÍTICO: Una transacción en estado terminal jamás se puede marcar como FAILED.
    // Si Transbank ya cobró (AUTHORIZED), hacer un rollback sería un desastre contable.
    // Si fue REJECTED/ABORTED/REVERSED, sobreescribir pierde información valiosa.
    if (this.props.status !== "INITIALIZED") {
      throw new Error(
        `[Domain] No se puede marcar FAILED una transacción en estado "${this.props.status}" (${this.props.id}).`,
      );
    }
    this.props.status = "FAILED";
  }

  public markAsReversed(): void {
    if (this.props.status !== "AUTHORIZED") {
      throw new Error(
        `[Domain] Solo se puede revertir una transacción AUTHORIZED. Estado actual: ${this.props.status}`,
      );
    }
    this.props.status = "REVERSED";
  }

  /** El Worker llama a esto para registrar cuándo auditó esta transacción. */
  public markAsPolled(): void {
    this.props.polledAt = new Date();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  public get isTerminal(): boolean {
    return ["AUTHORIZED", "REJECTED", "ABORTED", "FAILED", "REVERSED"].includes(this.props.status);
  }

  private assertStatus(expected: TransactionStatus, operation: string): void {
    if (this.props.status !== expected) {
      throw new Error(
        `[Domain] Transición inválida: "${operation}" requiere estado "${expected}" pero el estado actual es "${this.props.status}" (id: ${this.props.id}).`,
      );
    }
  }
}
