export type TransactionStatus =
  | "INITIALIZED"
  | "AUTHORIZED"
  | "REJECTED"
  | "ABORTED"
  | "FAILED"
  | "REVERSED";

/** Max length and charset per Transbank Webpay Plus REST API docs. */
export const TRANSBANK_BUY_ORDER_MAX_LENGTH = 26;
export const TRANSBANK_BUY_ORDER_PATTERN = /^[A-Za-z0-9|_=&%.,~:/?[+!@()>-]+$/;

export function isValidTransbankBuyOrder(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TRANSBANK_BUY_ORDER_MAX_LENGTH &&
    TRANSBANK_BUY_ORDER_PATTERN.test(value)
  );
}

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
  vci?: string;
  cardNumber?: string;
  accountingDate?: string;
  transactionDate?: Date;
  abortedReason?: string;
  polledAt?: Date;
  paymentUrl?: string;
  createdAt: Date;
}

export interface WebpayCommitData {
  authorizationCode: string;
  paymentTypeCode: string;
  installmentsNumber: number;
  installmentsAmount?: number;
  responseCode: number;
  vci: string;
  cardNumber?: string;
  accountingDate: string;
  transactionDate: string;
}

/**
 * Webpay transaction entity.
 *
 * Explicit state machine. No illegal transitions are possible.
 * Infrastructure (Prisma, HTTP) is an implementation detail external to this class.
 */
export class WebpayTransaction {
  constructor(public readonly props: WebpayTransactionProps) {}

  // ─── Factory Method ───────────────────────────────────────────────────────

  /** Transbank token TTL: 5 minutes from creation. */
  static readonly TOKEN_TTL_MS = 5 * 60 * 1000;

  public static initialize(
    buyOrder: string,
    sessionId: string,
    amount: number,
  ): WebpayTransaction {
    if (amount <= 0) {
      throw new Error("Transaction amount must be greater than zero.");
    }
    if (amount > 999_999_999) {
      throw new Error(
        "Transaction amount exceeds Transbank CLP limit of $999,999,999.",
      );
    }
    if (!isValidTransbankBuyOrder(buyOrder)) {
      throw new Error(
        "buy_order is invalid or exceeds Transbank limits (max 26 chars, allowed charset).",
      );
    }
    if (sessionId.length > 61) {
      throw new Error("session_id exceeds Transbank limit of 61 characters.");
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

  // ─── State Transitions ──────────────────────────────────────────────────

  public setToken(token: string): void {
    this.assertStatus("INITIALIZED", "setToken");
    this.props.token = token;
  }

  public setPaymentUrl(url: string): void {
    this.assertStatus("INITIALIZED", "setPaymentUrl");
    if (!url) throw new Error("[Domain] paymentUrl cannot be empty.");
    this.props.paymentUrl = url;
  }

  public markAsAuthorized(data: WebpayCommitData): void {
    this.assertStatus("INITIALIZED", "markAsAuthorized");

    if (data.cardNumber !== undefined && data.cardNumber.length > 4) {
      throw new Error(
        `[Domain] cardNumber must be at most 4 digits (PCI DSS). Received: ${data.cardNumber.length} characters.`,
      );
    }
    const parsedDate = new Date(data.transactionDate);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new Error(
        `[Domain] Invalid transactionDate from Transbank: "${data.transactionDate}". Manual audit required.`,
      );
    }

    this.props.status = "AUTHORIZED";
    this.props.authCode = data.authorizationCode;
    this.props.paymentTypeCode = data.paymentTypeCode;
    this.props.installmentsNumber = data.installmentsNumber;
    this.props.installmentsAmount = data.installmentsAmount;
    this.props.responseCode = data.responseCode;
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
    if (this.props.status !== "INITIALIZED") {
      throw new Error(
        `[Domain] Cannot mark FAILED: transaction is in "${this.props.status}" state (${this.props.id}).`,
      );
    }
    this.props.status = "FAILED";
  }

  public markAsReversed(): void {
    if (this.props.status !== "AUTHORIZED") {
      throw new Error(
        `[Domain] Only AUTHORIZED transactions can be reversed. Current status: ${this.props.status}`,
      );
    }
    this.props.status = "REVERSED";
  }

  /** Called by the worker to record when this transaction was polled. */
  public markAsPolled(): void {
    this.props.polledAt = new Date();
  }

  /** Whether the Transbank token has expired (5 min TTL from creation). */
  public get isTokenExpired(): boolean {
    return this.isTokenExpiredAt(WebpayTransaction.TOKEN_TTL_MS);
  }

  /** Check expiry against a custom TTL (e.g. integration form timeout is 10 min). */
  public isTokenExpiredAt(ttlMs: number): boolean {
    if (this.props.status !== "INITIALIZED") return false;
    const elapsed = Date.now() - this.props.createdAt.getTime();
    return elapsed > ttlMs;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  public get isTerminal(): boolean {
    return ["AUTHORIZED", "REJECTED", "ABORTED", "FAILED", "REVERSED"].includes(
      this.props.status,
    );
  }

  private assertStatus(expected: TransactionStatus, operation: string): void {
    if (this.props.status !== expected) {
      throw new Error(
        `[Domain] Invalid transition: "${operation}" requires "${expected}" but current state is "${this.props.status}" (id: ${this.props.id}).`,
      );
    }
  }
}
