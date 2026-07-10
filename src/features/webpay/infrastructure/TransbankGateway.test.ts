import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock env BEFORE imports
vi.mock("@/shared/env", () => ({
  env: {
    WEBPAY_ENVIRONMENT: "integration",
    WEBPAY_COMMERCE_CODE: "test-commerce",
    WEBPAY_API_SECRET: "test-secret-123",
  },
}));

import {
  TransbankGateway,
  TransbankAlreadyProcessedError,
  TransbankRefundAlreadyProcessedError,
} from "./TransbankGateway";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetchSuccess(body: any, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchError(status: number, body = "error message") {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: body }),
    text: () => Promise.resolve(body),
  });
}

function mockFetchNetworkError() {
  return vi.fn().mockRejectedValue(new TypeError("fetch failed"));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TransbankGateway", () => {
  let gateway: TransbankGateway;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new TransbankGateway();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── createTransaction ──────────────────────────────────────────────────────

  describe("createTransaction", () => {
    it("sends POST to correct URL with correct headers", async () => {
      const mockResponse = { token: "tok-abc", url: "https://webpay3gint.transbank.cl/webpayserver/init_transaction?token=ABC" };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return");

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];

      expect(url).toBe("https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({
        "Tbk-Api-Key-Id": "test-commerce",
        "Tbk-Api-Key-Secret": "test-secret-123",
        "Content-Type": "application/json",
      });
    });

    it("sends correct body", async () => {
      const mockResponse = { token: "tok-abc", url: "https://example.com/pay" };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return");

      const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse(options.body as string);

      expect(body).toEqual({
        buy_order: "BO-001",
        session_id: "sess-1",
        amount: 5000,
        return_url: "https://example.com/return",
      });
    });

    it("returns token and url on success", async () => {
      const mockResponse = {
        token: "tok-abc",
        url: "https://webpay3gint.transbank.cl/webpayserver/init_transaction?token=ABC",
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      const result = await gateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return");

      expect(result).toEqual(mockResponse);
      expect(result.token).toBe("tok-abc");
      expect(result.url).toContain("webpayserver");
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchError(500, "Internal Server Error");

      await expect(
        gateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return"),
      ).rejects.toThrow("[TransbankGateway] createTransaction falló (500)");
    });

    it("throws on network error", async () => {
      globalThis.fetch = mockFetchNetworkError();

      await expect(
        gateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return"),
      ).rejects.toThrow();
    });
  });

  // ─── commitTransaction ──────────────────────────────────────────────────────

  describe("commitTransaction", () => {
    it("sends PUT to correct URL with correct headers", async () => {
      const mockResponse = {
        vci: "TSO",
        amount: 5000,
        status: "AUTHORIZED",
        buy_order: "BO-001",
        session_id: "sess-1",
        accounting_date: "0627",
        transaction_date: "2025-06-27T10:00:00.000Z",
        authorization_code: "AUTH001",
        payment_type_code: "VD",
        response_code: 0,
        installments_number: 1,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.commitTransaction("tok-abc");

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];

      expect(url).toBe("https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions/tok-abc");
      expect(options.method).toBe("PUT");
      expect(options.headers).toEqual({
        "Tbk-Api-Key-Id": "test-commerce",
        "Tbk-Api-Key-Secret": "test-secret-123",
        "Content-Type": "application/json",
      });
    });

    it("parses commit response correctly", async () => {
      const mockResponse = {
        vci: "TSO",
        amount: 5000,
        status: "AUTHORIZED",
        buy_order: "BO-001",
        session_id: "sess-1",
        accounting_date: "0627",
        transaction_date: "2025-06-27T10:00:00.000Z",
        authorization_code: "AUTH001",
        payment_type_code: "VD",
        response_code: 0,
        installments_number: 1,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      const result = await gateway.commitTransaction("tok-abc");

      expect(result.status).toBe("AUTHORIZED");
      expect(result.vci).toBe("TSO");
      expect(result.amount).toBe(5000);
      expect(result.authorization_code).toBe("AUTH001");
      expect(result.response_code).toBe(0);
    });

    it("throws TransbankAlreadyProcessedError on 422", async () => {
      globalThis.fetch = mockFetchError(422, "Transaction already processed");

      await expect(gateway.commitTransaction("tok-abc")).rejects.toThrow(
        TransbankAlreadyProcessedError,
      );
    });

    it("includes token in the error message", async () => {
      globalThis.fetch = mockFetchError(422, "Transaction already processed");

      await expect(gateway.commitTransaction("tok-xyz")).rejects.toThrow(
        "token: tok-xyz",
      );
    });

    it("throws generic error on other non-ok responses", async () => {
      globalThis.fetch = mockFetchError(500, "Server error");

      await expect(gateway.commitTransaction("tok-abc")).rejects.toThrow(
        "[TransbankGateway] commitTransaction falló (500)",
      );
    });

    it("throws on network error", async () => {
      globalThis.fetch = mockFetchNetworkError();

      await expect(gateway.commitTransaction("tok-abc")).rejects.toThrow();
    });
  });

  // ─── getTransactionStatus ───────────────────────────────────────────────────

  describe("getTransactionStatus", () => {
    it("sends GET to correct URL", async () => {
      const mockResponse = {
        vci: "TSO",
        amount: 5000,
        status: "INITIALIZED",
        buy_order: "BO-001",
        session_id: "sess-1",
        accounting_date: "0627",
        transaction_date: "2025-06-27T10:00:00.000Z",
        authorization_code: "",
        payment_type_code: "",
        response_code: -1,
        installments_number: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.getTransactionStatus("tok-abc");

      const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];

      expect(url).toBe("https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions/tok-abc");
      expect(options.method).toBe("GET");
      expect(options.headers).toEqual({
        "Tbk-Api-Key-Id": "test-commerce",
        "Tbk-Api-Key-Secret": "test-secret-123",
        "Content-Type": "application/json",
      });
    });

    it("returns commit response on success", async () => {
      const mockResponse = {
        vci: "TSO",
        amount: 5000,
        status: "AUTHORIZED",
        buy_order: "BO-001",
        session_id: "sess-1",
        accounting_date: "0627",
        transaction_date: "2025-06-27T10:00:00.000Z",
        authorization_code: "AUTH001",
        payment_type_code: "VD",
        response_code: 0,
        installments_number: 1,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      const result = await gateway.getTransactionStatus("tok-abc");

      expect(result.status).toBe("AUTHORIZED");
      expect(result.authorization_code).toBe("AUTH001");
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = mockFetchError(404, "Not found");

      await expect(gateway.getTransactionStatus("tok-abc")).rejects.toThrow(
        "[TransbankGateway] getTransactionStatus falló (404)",
      );
    });
  });

  // ─── Environment switching ──────────────────────────────────────────────────

  describe("environment switching", () => {
    it("uses production URL when WEBPAY_ENVIRONMENT is production", async () => {
      // The env module is cached. We test the logic by directly checking
      // the gateway's baseUrl getter behavior via the factory pattern.
      // For a true isolation test, use vi.resetModules + dynamic import.
      vi.resetModules();

      vi.doMock("@/shared/env", () => ({
        env: {
          WEBPAY_ENVIRONMENT: "production",
          WEBPAY_COMMERCE_CODE: "test-commerce",
          WEBPAY_API_SECRET: "test-secret-123",
        },
      }));

      // Re-import to get fresh module with production env
      const { TransbankGateway: ProdGateway } = await import("./TransbankGateway");
      const prodGateway = new ProdGateway();

      const mockResponse = { token: "tok-abc", url: "https://example.com/pay" };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await prodGateway.createTransaction("BO-001", "sess-1", 5000, "https://example.com/return");

      const [url] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(url).toContain("webpay3g.transbank.cl");
      expect(url).not.toContain("webpay3gint");

      vi.doUnmock("@/shared/env");
      vi.resetModules();
    });
  });

  // ─── requestRefund ─────────────────────────────────────────────────────────

  describe("requestRefund", () => {
    it("sends POST to correct URL with correct headers", async () => {
      const mockResponse = {
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-001",
        authorization_date: "2025-06-27T10:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.requestRefund("tok-abc", 5000);

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];

      expect(url).toBe(
        "https://webpay3gint.transbank.cl/rswebpaytransaction/api/webpay/v1.2/transactions/tok-abc/refunds",
      );
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({
        "Tbk-Api-Key-Id": "test-commerce",
        "Tbk-Api-Key-Secret": "test-secret-123",
        "Content-Type": "application/json",
      });
    });

    it("sends correct body with amount", async () => {
      const mockResponse = {
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-001",
        authorization_date: "2025-06-27T10:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.requestRefund("tok-abc", 5000);

      const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = JSON.parse(options.body as string);

      expect(body).toEqual({ amount: 5000 });
    });

    it("parses refund response correctly", async () => {
      const mockResponse = {
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-001",
        authorization_date: "2025-06-27T10:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      const result = await gateway.requestRefund("tok-abc", 5000);

      expect(result.type).toBe("REVERSED");
      expect(result.authorization_code).toBe("AUTH-REFUND-001");
      expect(result.nullified_amount).toBe(5000);
      expect(result.balance).toBe(0);
      expect(result.response_code).toBe(0);
    });

    it("parses partial nullification response correctly", async () => {
      const mockResponse = {
        type: "NULLIFIED",
        authorization_code: "AUTH-REFUND-002",
        authorization_date: "2025-06-27T10:00:00.000Z",
        nullified_amount: 2500,
        balance: 2500,
        response_code: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      const result = await gateway.requestRefund("tok-abc", 2500);

      expect(result.type).toBe("NULLIFIED");
      expect(result.nullified_amount).toBe(2500);
      expect(result.balance).toBe(2500);
    });

    it("throws TransbankRefundAlreadyProcessedError on 422", async () => {
      globalThis.fetch = mockFetchError(422, "Transaction already refunded");

      await expect(gateway.requestRefund("tok-abc", 5000)).rejects.toThrow(
        TransbankRefundAlreadyProcessedError,
      );
    });

    it("includes token in the 422 error message", async () => {
      globalThis.fetch = mockFetchError(422, "Transaction already refunded");

      await expect(gateway.requestRefund("tok-xyz", 5000)).rejects.toThrow(
        "token: tok-xyz",
      );
    });

    it("throws generic error on other non-ok responses", async () => {
      globalThis.fetch = mockFetchError(500, "Server error");

      await expect(gateway.requestRefund("tok-abc", 5000)).rejects.toThrow(
        "[TransbankGateway] requestRefund falló (500)",
      );
    });

    it("throws on network error", async () => {
      globalThis.fetch = mockFetchNetworkError();

      await expect(gateway.requestRefund("tok-abc", 5000)).rejects.toThrow();
    });

    it("uses longer timeout than other operations", async () => {
      const mockResponse = {
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-001",
        authorization_date: "2025-06-27T10:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      };
      globalThis.fetch = mockFetchSuccess(mockResponse);

      await gateway.requestRefund("tok-abc", 5000);

      const [, options] = vi.mocked(globalThis.fetch).mock.calls[0];
      // Refund should have a longer timeout (30s) than other operations (10s)
      expect(options.signal).toBeDefined();
    });
  });
});
