import { env } from "@/shared/env";

// ─── Interfaces de Respuesta (Anti-Corruption Layer) ─────────────────────────

export interface WebpayInitResponse {
  token: string;
  url: string;
}

export interface WebpayCommitResponse {
  vci: string;
  amount: number;
  status: string;
  buy_order: string;
  session_id: string;
  card_detail?: { card_number: string };
  accounting_date: string;
  transaction_date: string;
  authorization_code: string;
  payment_type_code: string;
  response_code: number;
  installments_amount?: number;
  installments_number: number;
  balance?: number;
}

export interface WebpayRefundResponse {
  type: string; // 'REVERSED' | 'NULLIFIED'
  authorization_code: string;
  authorization_date: string;
  nullified_amount: number;
  balance: number;
  response_code: number;
}

/**
 * Error tipado para cuando Transbank responde 422 en commit.
 * Significa que la transacción YA fue procesada previamente.
 * El caso de uso lo captura para hacer fallback a getTransactionStatus
 * en vez de marcar la transacción como FAILED (que sería un crimen contable).
 */
export class TransbankAlreadyProcessedError extends Error {
  constructor(token: string) {
    super(`[TransbankGateway] Transacción ya procesada (422) para token: ${token}`);
    this.name = "TransbankAlreadyProcessedError";
  }
}

/**
 * Error tipado para cuando Transbank responde 422 en refund.
 * Significa que la transacción YA fue reembolsada/anulada previamente.
 * El caso de uso lo captura para evitar doble reembolso (riesgo financiero).
 *
 * Transbank docs: response_code 310 = "Transacción anulada previamente"
 * En la API REST, esto viene como HTTP 422 con error_message en el body.
 */
export class TransbankRefundAlreadyProcessedError extends Error {
  constructor(token: string) {
    super(`[TransbankGateway] Refund ya procesado (422) para token: ${token}`);
    this.name = "TransbankRefundAlreadyProcessedError";
  }
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

/**
 * Transbank API Adapter — Capa de Infraestructura.
 *
 * Este adaptador es la ÚNICA clase que sabe que Transbank existe.
 * El Dominio y la Aplicación no conocen URLs, headers ni HTTP.
 * Si mañana Transbank cambia su API, sólo tocamos esta clase.
 */
export class TransbankGateway {
  private readonly apiPath = "/rswebpaytransaction/api/webpay/v1.2/transactions";

  private get baseUrl(): string {
    return env.WEBPAY_ENVIRONMENT === "integration"
      ? "https://webpay3gint.transbank.cl"
      : "https://webpay3g.transbank.cl";
  }

  private get headers(): Record<string, string> {
    return {
      "Tbk-Api-Key-Id": env.WEBPAY_COMMERCE_CODE,
      "Tbk-Api-Key-Secret": env.WEBPAY_API_SECRET,
      "Content-Type": "application/json",
    };
  }

  // ─── POST /transactions ─────────────────────────────────────────────────────

  /**
   * Crea una transacción en Transbank y obtiene el token + URL de redirección.
   * Esto es lo primero que se llama. Sin token, no hay pago.
   */
  public async createTransaction(
    buyOrder: string,
    sessionId: string,
    amount: number,
    returnUrl: string,
  ): Promise<WebpayInitResponse> {
    const response = await fetch(`${this.baseUrl}${this.apiPath}`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        buy_order: buyOrder,
        session_id: sessionId,
        amount,
        return_url: returnUrl,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[TransbankGateway] createTransaction falló (${response.status}): ${body}`);
    }

    return response.json() as Promise<WebpayInitResponse>;
  }

  // ─── PUT /transactions/{token} ──────────────────────────────────────────────

  /**
   * Confirma (hace "commit") la transacción cuando el usuario regresa del banco.
   * Según Transbank Docs: se llama UNA sola vez. Si se llama dos veces → 422.
   *
   * Si recibimos 422, lanzamos TransbankAlreadyProcessedError (no Error genérico)
   * para que el caso de uso pueda reaccionar inteligentemente en vez de marcar FAILED.
   */
  public async commitTransaction(token: string): Promise<WebpayCommitResponse> {
    const response = await fetch(`${this.baseUrl}${this.apiPath}/${token}`, {
      method: "PUT",
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });

    // 422 = ya fue procesado anteriormente (doble clic, reload, reintento del worker)
    if (response.status === 422) {
      throw new TransbankAlreadyProcessedError(token);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[TransbankGateway] commitTransaction falló (${response.status}): ${body}`);
    }

    return response.json() as Promise<WebpayCommitResponse>;
  }

  // ─── GET /transactions/{token} ──────────────────────────────────────────────

  /**
   * Consulta el estado actual de una transacción.
   *
   * ¿Cuándo se usa? Dos escenarios:
   * 1. El Worker de polling: busca transacciones abandonadas y pregunta a Transbank
   *    si el usuario pagó (incluso si nunca llegó al return URL).
   * 2. Fallback del 422: si commitTransaction tira 422, en vez de marcar FAILED
   *    consultamos el estado real para saber qué pasó.
   *
   * Nota importante de la doc de Transbank: este endpoint solo está disponible
   * durante los primeros 7 días desde que se creó la transacción.
   */
  public async getTransactionStatus(token: string): Promise<WebpayCommitResponse> {
    const response = await fetch(`${this.baseUrl}${this.apiPath}/${token}`, {
      method: "GET",
      headers: this.headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `[TransbankGateway] getTransactionStatus falló (${response.status}): ${body}`,
      );
    }

    return response.json() as Promise<WebpayCommitResponse>;
  }

  // ─── POST /transactions/{token}/refunds ─────────────────────────────────────

  /**
   * Anula un pago ya autorizado (Refund / Reversa).
   *
   * ¿Cuándo se usa?
   * - Cuando el backend falla DESPUÉS de que Transbank autorizó el cobro.
   *   Sin esto, el usuario pierde dinero en un error que no fue suyo.
   * - Cuando el usuario solicita devolución.
   *
   * Regla de Transbank: solo se puede revertir dentro del mismo día contable.
   * Pasado ese límite, se llama "Anulación" y tiene sus propias restricciones.
   *
   * Timeout: 30s (vs 10s de otras operaciones). Los refunds pasan por
   * aprobación del acquiring bank y pueden ser más lentos que un commit normal.
   *
   * 422 = refund ya procesado previamente. lanzamos TransbankRefundAlreadyProcessedError
   * para que el caso de uso pueda detectar el doble-reembolso y actuar en consecuencia.
   */
  public async requestRefund(token: string, amount: number): Promise<WebpayRefundResponse> {
    const response = await fetch(`${this.baseUrl}${this.apiPath}/${token}/refunds`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ amount }),
      signal: AbortSignal.timeout(30_000), // 30s — refunds son más lentos
    });

    // 422 = refund ya procesado (doble clic, reintento, etc.)
    if (response.status === 422) {
      throw new TransbankRefundAlreadyProcessedError(token);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[TransbankGateway] requestRefund falló (${response.status}): ${body}`);
    }

    return response.json() as Promise<WebpayRefundResponse>;
  }
}
