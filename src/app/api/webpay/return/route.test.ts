import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebpayTransaction } from "@/features/webpay/domain/Transaction";

// ─── Mock Variables (module scope — vi.hoisted removed in vitest 4.x) ─────────

const commitTransactionMock = vi.fn();

const mockGateway = {
  createTransaction: vi.fn(),
  commitTransaction: (...args: any[]) => commitTransactionMock(...args),
  getTransactionStatus: vi.fn(),
  requestRefund: vi.fn(),
  _commitTransactionMock: commitTransactionMock,
};

const mockRepoStore = new Map<string, WebpayTransaction>();

// ─── Mock Modules ─────────────────────────────────────────────────────────────

vi.mock("@/features/webpay/infrastructure/PrismaTransactionRepository", () => ({
  transactionRepository: {
    save: async (tx: WebpayTransaction) => {
      mockRepoStore.set(tx.props.id, tx);
    },
    findByToken: async (token: string) => {
      for (const tx of mockRepoStore.values()) {
        if (tx.props.token === token) return tx;
      }
      return null;
    },
    findByBuyOrder: async (buyOrder: string) => {
      for (const tx of mockRepoStore.values()) {
        if (tx.props.buyOrder === buyOrder) return tx;
      }
      return null;
    },
    findStaleInitialized: async (olderThanMinutes: number) => {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
      return Array.from(mockRepoStore.values()).filter(
        (tx) =>
          tx.props.status === "INITIALIZED" &&
          tx.props.createdAt < cutoff &&
          !tx.props.polledAt,
      );
    },
  },
}));

vi.mock("@/shared/env", () => ({
  env: {
    WEBPAY_COMMERCE_CODE: "597055555532",
    WEBPAY_API_SECRET: "test-secret",
    WEBPAY_ENVIRONMENT: "integration",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    CRON_SECRET: "test-cron-secret",
  },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

import { POST, GET } from "./route";
import { __setGatewayForTesting, __resetGatewayForTesting } from "@/features/webpay/application/transactionActions";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seed(tx: WebpayTransaction) {
  mockRepoStore.set(tx.props.id, tx);
}

function clearRepo() {
  mockRepoStore.clear();
}

function createPostRequest(body?: string, url = "http://localhost:3000/api/webpay/return") {
  const parsedUrl = new URL(url);
  return {
    method: "POST",
    headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    text: async () => body ?? "",
    url,
    nextUrl: parsedUrl,
  } as any;
}

function createGetRequest(url: string) {
  const parsedUrl = new URL(url);
  return {
    method: "GET",
    headers: new Headers(),
    url,
    nextUrl: parsedUrl,
  } as any;
}

function mockCommitAuthorized() {
  mockGateway._commitTransactionMock.mockResolvedValueOnce({
    vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
    session_id: "session-1", accounting_date: "0101",
    transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
    payment_type_code: "VD", response_code: 0, installments_number: 1,
  });
}

function mockCommitRejected(responseCode = -1) {
  mockGateway._commitTransactionMock.mockResolvedValueOnce({
    vci: "TSO", amount: 5000, status: "REJECTED", buy_order: "BO123",
    session_id: "session-1", accounting_date: "0101",
    transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "",
    payment_type_code: "VD", response_code: responseCode, installments_number: 1,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  clearRepo();
  await __setGatewayForTesting(mockGateway as any);
});

afterEach(async () => {
  await __resetGatewayForTesting();
});

describe("POST /api/webpay/return", () => {
  describe("Payment completed (token_ws present)", () => {
    it("redirects to success page when payment is AUTHORIZED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockCommitAuthorized();

      const req = createPostRequest("token_ws=tok_test_123");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("/checkout/success");
    });

    it("redirects to error page when payment is REJECTED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockCommitRejected(-1);

      const req = createPostRequest("token_ws=tok_test_123");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("/checkout/error");
      expect(response.headers.get("location")).toContain("reason=REJECTED");
    });
  });

  describe("User cancelled (TBK_TOKEN present)", () => {
    it("redirects to error page with aborted_by_user reason", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      seed(tx);

      const req = createPostRequest(
        "TBK_TOKEN=tbk_cancel_123&TBK_ORDEN_COMPRA=BO123&TBK_ID_SESION=session-1",
      );
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=aborted_by_user");
    });

    it("marks transaction as ABORTED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      seed(tx);

      const req = createPostRequest(
        "TBK_TOKEN=tbk_cancel_123&TBK_ORDEN_COMPRA=BO123&TBK_ID_SESION=session-1",
      );
      await POST(req);

      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.status).toBe("ABORTED");
    });
  });

  describe("Invalid payload", () => {
    it("redirects to error page when no token_ws or TBK_TOKEN", async () => {
      const req = createPostRequest("some_param=value");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=invalid_payload");
    });

    it("redirects to error page when body is empty", async () => {
      const req = createPostRequest("");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=invalid_payload");
    });
  });

  describe("System errors", () => {
    it("redirects to system_failed when confirmTransactionAction throws", async () => {
      // When findByToken itself throws (DB error), confirmTransactionAction propagates the error
      const originalFindByToken = mockRepoStore.get;
      mockRepoStore.get = () => {
        throw new Error("DB connection lost");
      };

      const req = createPostRequest("token_ws=tok_test_123");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=system_failed");

      // Restore
      mockRepoStore.get = originalFindByToken;
    });

    it("redirects to error page with FAILED reason when commit fails internally", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      // Mock gateway to throw a non-TransbankAlreadyProcessedError
      // confirmTransactionAction catches it internally, marks FAILED, returns result
      mockGateway._commitTransactionMock.mockRejectedValueOnce(new Error("Unexpected error"));

      const req = createPostRequest("token_ws=tok_test_123");
      const response = await POST(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=FAILED");
    });
  });

  describe("Edge cases", () => {
    it("treats request with both token_ws and TBK_TOKEN as cancellation", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      seed(tx);

      const req = createPostRequest(
        "token_ws=tok_test&TBK_TOKEN=tbk_cancel&TBK_ORDEN_COMPRA=BO123&TBK_ID_SESION=session-1",
      );
      const response = await POST(req);

      // TBK_TOKEN takes priority — treated as cancellation
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=aborted_by_user");
    });
  });
});

describe("GET /api/webpay/return", () => {
  describe("Timeout (TBK_TOKEN in query)", () => {
    it("redirects to error page with timeout reason", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      seed(tx);

      const req = createGetRequest(
        "http://localhost:3000/api/webpay/return?TBK_TOKEN=tbk_timeout&TBK_ORDEN_COMPRA=BO123&TBK_ID_SESION=session-1",
      );
      const response = await GET(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=timeout");
    });
  });

  describe("Page reload after successful payment", () => {
    it("redirects to success page when transaction is already AUTHORIZED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        installmentsAmount: 5000,
        responseCode: 0,
      });
      seed(tx);

      const req = createGetRequest(
        "http://localhost:3000/api/webpay/return?token_ws=tok_test_123",
      );
      const response = await GET(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("/checkout/success");
    });
  });

  describe("No token", () => {
    it("redirects to error page when no token in query", async () => {
      const req = createGetRequest("http://localhost:3000/api/webpay/return");
      const response = await GET(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=no_token");
    });
  });

  describe("System errors", () => {
    it("redirects to system_failed when transaction lookup throws", async () => {
      // Mock findByToken to throw
      const originalFindByToken = mockRepoStore.get;
      mockRepoStore.get = () => {
        throw new Error("DB connection lost");
      };

      const req = createGetRequest(
        "http://localhost:3000/api/webpay/return?token_ws=tok_test",
      );
      const response = await GET(req);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("reason=system_failed");

      // Restore
      mockRepoStore.get = originalFindByToken;
    });
  });
});
