import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebpayTransaction } from "../domain/Transaction";

// ─── Mock Variables (module scope — vi.hoisted removed in vitest 4.x) ─────────

const commitTransactionMock = vi.fn();
const getTransactionStatusMock = vi.fn();
const createTransactionMock = vi.fn();

const mockGateway = {
  createTransaction: (...args: any[]) => createTransactionMock(...args),
  commitTransaction: (...args: any[]) => commitTransactionMock(...args),
  getTransactionStatus: (...args: any[]) => getTransactionStatusMock(...args),
  requestRefund: vi.fn(),
  // Expose mocks for configuration
  _commitTransactionMock: commitTransactionMock,
  _getTransactionStatusMock: getTransactionStatusMock,
  _createTransactionMock: createTransactionMock,
};

const mockRepoStore = new Map<string, WebpayTransaction>();

// ─── Mock Modules ─────────────────────────────────────────────────────────────

vi.mock("../infrastructure/PrismaTransactionRepository", () => ({
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

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// ─── Import Actions + DI helpers ──────────────────────────────────────────────

import {
  initiateTransactionAction,
  confirmTransactionAction,
  abortTransactionAction,
  pollStaleTransactionsAction,
  __setGatewayForTesting,
  __resetGatewayForTesting,
} from "./transactionActions";
import { TransbankAlreadyProcessedError } from "../infrastructure/TransbankGateway";
import { redirect } from "next/navigation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seed(tx: WebpayTransaction) {
  mockRepoStore.set(tx.props.id, tx);
}

function clearRepo() {
  mockRepoStore.clear();
}

function mockCommitAuthorized(overrides?: Record<string, unknown>) {
  mockGateway._commitTransactionMock.mockResolvedValueOnce({
    vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
    session_id: "session-1", accounting_date: "0101",
    transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
    payment_type_code: "VD", response_code: 0, installments_number: 1,
    ...overrides,
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

function mockGetStatusAuthorized() {
  mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
    vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
    session_id: "session-1", accounting_date: "0101",
    transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
    payment_type_code: "VD", response_code: 0, installments_number: 1,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.clearAllMocks();
  clearRepo();
  // Inject mock gateway via DI before each test
  await __setGatewayForTesting(mockGateway as any);
});

afterEach(async () => {
  await __resetGatewayForTesting();
});

describe("confirmTransactionAction", () => {
  describe("Normal flow (commit succeeds)", () => {
    it("transitions INITIALIZED → AUTHORIZED on successful commit", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockCommitAuthorized();

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("AUTHORIZED");
      expect(result.authCode).toBe("AUTH001");
    });

    it("transitions INITIALIZED → REJECTED when Transbank rejects", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockCommitRejected(-1);

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("REJECTED");
      expect(result.responseCode).toBe(-1);
    });
  });

  describe("Idempotency (already terminal)", () => {
    it("returns current state without calling Transbank if already AUTHORIZED", async () => {
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

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("AUTHORIZED");
      expect(mockGateway._commitTransactionMock).not.toHaveBeenCalled();
    });

    it("returns current state without calling Transbank if already REJECTED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      tx.markAsRejected(-1);
      seed(tx);

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("REJECTED");
      expect(mockGateway._commitTransactionMock).not.toHaveBeenCalled();
    });
  });

  describe("422 handling (already processed)", () => {
    it("falls back to getTransactionStatus when commit returns 422", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockGateway._commitTransactionMock.mockRejectedValueOnce(
        new TransbankAlreadyProcessedError("tok_test_123"),
      );
      mockGetStatusAuthorized();

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("AUTHORIZED");
      expect(mockGateway._getTransactionStatusMock).toHaveBeenCalledWith("tok_test_123");
    });
  });

  describe("Error handling", () => {
    it("throws when token not found", async () => {
      await expect(confirmTransactionAction("nonexistent")).rejects.toThrow(
        "Transacción no encontrada",
      );
    });

    it("marks as FAILED on network error", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_test_123");
      seed(tx);

      mockGateway._commitTransactionMock.mockRejectedValueOnce(new Error("Network error"));

      const result = await confirmTransactionAction("tok_test_123");

      expect(result.status).toBe("FAILED");
    });
  });
});

describe("abortTransactionAction", () => {
  it("marks transaction as ABORTED when found", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    seed(tx);

    await abortTransactionAction("tbk_token_123", "BO123");

    const updated = mockRepoStore.get(tx.props.id);
    expect(updated).toBeDefined();
    expect(updated!.props.status).toBe("ABORTED");
    expect(updated!.props.abortedReason).toContain("tbk_token_123");
  });

  it("does nothing when buyOrder not found (logs warning)", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await abortTransactionAction("tbk_token_123", "NONEXISTENT");

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("NONEXISTENT"),
    );
    consoleSpy.mockRestore();
  });

  it("does nothing when transaction is already terminal", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.markAsAuthorized({
      authorizationCode: "AUTH001",
      paymentTypeCode: "VD",
      installmentsNumber: 1,
      installmentsAmount: 5000,
      responseCode: 0,
    });
    seed(tx);

    await abortTransactionAction("tbk_token_123", "BO123");

    const updated = mockRepoStore.get(tx.props.id);
    expect(updated!.props.status).toBe("AUTHORIZED");
  });
});

describe("initiateTransactionAction", () => {
  describe("Happy path", () => {
    it("creates transaction, persists to DB, calls Transbank, and redirects", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "tbk_new_token_123",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      await expect(initiateTransactionAction(5000)).rejects.toThrow("NEXT_REDIRECT");

      // Verify transaction was persisted
      const allTx = Array.from(mockRepoStore.values());
      expect(allTx).toHaveLength(1);
      const tx = allTx[0];
      expect(tx.props.amount).toBe(5000);
      expect(tx.props.status).toBe("INITIALIZED");
      expect(tx.props.token).toBe("tbk_new_token_123");

      // Verify redirect was called with correct URL
      expect(redirect).toHaveBeenCalledWith(
        expect.stringContaining("https://webpay3g.transbank.cl/webpayserver/init_transaction?token_ws=tbk_new_token_123"),
      );
    });

    it("generates unique buy_order with BO prefix", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "token_1",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      await expect(initiateTransactionAction(5000)).rejects.toThrow("NEXT_REDIRECT");

      const allTx = Array.from(mockRepoStore.values());
      expect(allTx[0].props.buyOrder).toMatch(/^BO[A-F0-9]{20}$/);
    });
  });

  describe("Amount validation", () => {
    it("throws when amount is zero", async () => {
      await expect(initiateTransactionAction(0)).rejects.toThrow("Monto inválido");
    });

    it("throws when amount is negative", async () => {
      await expect(initiateTransactionAction(-1000)).rejects.toThrow("Monto inválido");
    });

    it("accepts maximum valid amount (999,999,999)", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "token_max",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      await expect(initiateTransactionAction(999_999_999)).rejects.toThrow("NEXT_REDIRECT");

      const allTx = Array.from(mockRepoStore.values());
      expect(allTx[0].props.amount).toBe(999_999_999);
    });
  });

  describe("Transbank failure", () => {
    it("marks transaction as FAILED and throws when Transbank rejects", async () => {
      mockGateway._createTransactionMock.mockRejectedValueOnce(new Error("Transbank down"));

      await expect(initiateTransactionAction(5000)).rejects.toThrow("Fallo al inicializar Gateway");

      const allTx = Array.from(mockRepoStore.values());
      expect(allTx).toHaveLength(1);
      expect(allTx[0].props.status).toBe("FAILED");
    });

    it("persists transaction BEFORE calling Transbank (traceability)", async () => {
      // First call: Transbank fails
      mockGateway._createTransactionMock.mockRejectedValueOnce(new Error("Transbank down"));

      await expect(initiateTransactionAction(5000)).rejects.toThrow("Fallo al inicializar Gateway");

      // Transaction should exist in DB even though Transbank failed
      const allTx = Array.from(mockRepoStore.values());
      expect(allTx).toHaveLength(1);
      expect(allTx[0].props.status).toBe("FAILED");
    });
  });
});

describe("confirmTransactionAction - Additional cases", () => {
  it("422 → getTransactionStatus → REJECTED (fallback to rejected status)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_test_123");
    seed(tx);

    mockGateway._commitTransactionMock.mockRejectedValueOnce(
      new TransbankAlreadyProcessedError("tok_test_123"),
    );
    mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "REJECTED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "",
      payment_type_code: "VD", response_code: -1, installments_number: 1,
    });

    const result = await confirmTransactionAction("tok_test_123");

    expect(result.status).toBe("REJECTED");
    expect(result.responseCode).toBe(-1);
    expect(mockGateway._getTransactionStatusMock).toHaveBeenCalledWith("tok_test_123");
  });

  it("422 → getTransactionStatus throws → marks as FAILED (error propagates to outer catch)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_test_123");
    seed(tx);

    mockGateway._commitTransactionMock.mockRejectedValueOnce(
      new TransbankAlreadyProcessedError("tok_test_123"),
    );
    mockGateway._getTransactionStatusMock.mockRejectedValueOnce(new Error("Network error"));

    const result = await confirmTransactionAction("tok_test_123");

    // When getTransactionStatus throws inside the 422 handler, the error
    // propagates to the outer catch which marks as FAILED (not a TransbankAlreadyProcessedError)
    expect(result.status).toBe("FAILED");
  });
});

describe("pollStaleTransactionsAction", () => {
  describe("Stale transactions found", () => {
    it("processes stale transactions and updates status to AUTHORIZED", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_stale_1");
      // Make it stale (>10 minutes old)
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
        payment_type_code: "VD", response_code: 0, installments_number: 1,
      });

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.authorized).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.failed).toBe(0);

      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.status).toBe("AUTHORIZED");
      expect(updated!.props.polledAt).toBeDefined();
    });

    it("updates status to REJECTED when Transbank rejects", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_stale_2");
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "REJECTED", buy_order: "BO123",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "",
        payment_type_code: "VD", response_code: -1, installments_number: 1,
      });

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.rejected).toBe(1);

      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.status).toBe("REJECTED");
    });

    it("marks as FAILED when transaction has no token", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      // No token set
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);

      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.status).toBe("FAILED");
    });

    it("skips ambiguous status (no response_code)", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_stale_3");
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "INITIALIZED", buy_order: "BO123",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "",
        payment_type_code: "", response_code: undefined, installments_number: 0,
      });

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.authorized).toBe(0);
      expect(result.rejected).toBe(0);

      // Transaction should NOT be marked as polled (stays in INITIALIZED for retry)
      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.polledAt).toBeUndefined();
    });
  });

  describe("Transbank errors", () => {
    it("marks as FAILED when transaction is older than 7 days and Transbank fails", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_stale_4");
      // 8 days old
      tx.props.createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      seed(tx);

      mockGateway._getTransactionStatusMock.mockRejectedValueOnce(new Error("Network error"));

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);

      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.status).toBe("FAILED");
    });

    it("leaves for next cycle when Transbank fails but transaction is < 7 days old", async () => {
      const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
      tx.setToken("tok_stale_5");
      // 15 minutes old (< 7 days)
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      mockGateway._getTransactionStatusMock.mockRejectedValueOnce(new Error("Network error"));

      const result = await pollStaleTransactionsAction();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);

      // Transaction should NOT be marked as polled (stays in INITIALIZED for retry)
      const updated = mockRepoStore.get(tx.props.id);
      expect(updated!.props.polledAt).toBeUndefined();
    });
  });
});
