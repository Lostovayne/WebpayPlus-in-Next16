import type {
  WebpayInitResponse,
  WebpayCommitResponse,
  WebpayRefundResponse,
} from "../infrastructure/TransbankGateway";
import { TransbankAlreadyProcessedError } from "../infrastructure/TransbankGateway";

/**
 * Mock del TransbankGateway para tests.
 *
 * Permite configurar respuestas por método y simular errores específicos.
 * No hace llamadas HTTP reales.
 */
export class MockTransbankGateway {
  public createTransactionMock = vi.fn<
    [string, string, number, string],
    Promise<WebpayInitResponse>
  >();
  public commitTransactionMock = vi.fn<[string], Promise<WebpayCommitResponse>>();
  public getTransactionStatusMock = vi.fn<[string], Promise<WebpayCommitResponse>>();
  public requestRefundMock = vi.fn<[string, number], Promise<WebpayRefundResponse>>();

  async createTransaction(
    buyOrder: string,
    sessionId: string,
    amount: number,
    returnUrl: string,
  ): Promise<WebpayInitResponse> {
    return this.createTransactionMock(buyOrder, sessionId, amount, returnUrl);
  }

  async commitTransaction(token: string): Promise<WebpayCommitResponse> {
    return this.commitTransactionMock(token);
  }

  async getTransactionStatus(token: string): Promise<WebpayCommitResponse> {
    return this.getTransactionStatusMock(token);
  }

  async requestRefund(token: string, amount: number): Promise<WebpayRefundResponse> {
    return this.requestRefundMock(token, amount);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Simula Transbank respondiendo 422 (ya procesado) */
  throwAlreadyProcessed(token: string) {
    this.commitTransactionMock.mockRejectedValueOnce(
      new TransbankAlreadyProcessedError(token),
    );
  }

  /** Configura respuesta exitosa de createTransaction */
  mockCreateSuccess(token = "tok_test_123", url = "https://webpay3gint.transbank.cl/webpayserver/initTransaction") {
    this.createTransactionMock.mockResolvedValueOnce({ token, url });
  }

  /** Configura respuesta exitosa de commitTransaction */
  mockCommitAuthorized(overrides?: Partial<WebpayCommitResponse>) {
    this.commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO",
      amount: 5000,
      status: "AUTHORIZED",
      buy_order: "BO123",
      session_id: "session-1",
      accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z",
      authorization_code: "AUTH001",
      payment_type_code: "VD",
      response_code: 0,
      installments_number: 1,
      ...overrides,
    });
  }

  /** Configura respuesta de commitTransaction con REJECTED */
  mockCommitRejected(responseCode = -1) {
    this.commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO",
      amount: 5000,
      status: "REJECTED",
      buy_order: "BO123",
      session_id: "session-1",
      accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z",
      authorization_code: "",
      payment_type_code: "VD",
      response_code: responseCode,
      installments_number: 1,
    });
  }

  /** Configura respuesta de getTransactionStatus */
  mockGetStatusAuthorized() {
    this.getTransactionStatusMock.mockResolvedValueOnce({
      vci: "TSO",
      amount: 5000,
      status: "AUTHORIZED",
      buy_order: "BO123",
      session_id: "session-1",
      accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z",
      authorization_code: "AUTH001",
      payment_type_code: "VD",
      response_code: 0,
      installments_number: 1,
    });
  }

  /** Configura error genérico de Transbank */
  mockNetworkError() {
    this.commitTransactionMock.mockRejectedValueOnce(new Error("Network error"));
  }
}
