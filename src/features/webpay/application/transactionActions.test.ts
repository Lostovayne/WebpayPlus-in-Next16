import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebpayTransaction } from "../domain/Transaction";
import { prisma } from "@/shared/lib/prisma";

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

vi.mock("@/shared/lib/prisma", () => ({
  prisma: {
    transactionAuditLog: {
      create: vi.fn(async () => ({})),
    },
  },
}));

// ─── Import Actions + DI helpers ──────────────────────────────────────────────

import {
  initiateTransactionAction,
  confirmTransactionAction,
  abortTransactionAction,
  pollStaleTransactionsAction,
  refundTransactionAction,
  __setGatewayForTesting,
  __resetGatewayForTesting,
} from "./transactionActions";
import {
  TransbankAlreadyProcessedError,
  TransbankRefundAlreadyProcessedError,
} from "../infrastructure/TransbankGateway";

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
    card_detail: { card_number: "1234567890123456" },
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
    card_detail: { card_number: "1234567890123456" },
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
      // Audit trail — verify new fields are stored
      expect(result.vci).toBe("TSO");
      expect(result.cardNumber).toBe("3456"); // last 4 of "1234567890123456"
      expect(result.accountingDate).toBe("0101");
      expect(result.transactionDate).toBeInstanceOf(Date);
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
        vci: "TSO",
        accountingDate: "0101",
        transactionDate: "2026-01-01T00:00:00.000Z",
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
        "Transaction not found",
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

  it("marks as FAILED when token is expired (>5 min) without calling Transbank", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_expired_1");
    // Simulate creation 6 minutes ago
    tx.props.createdAt = new Date(Date.now() - 6 * 60 * 1000);
    seed(tx);

    const result = await confirmTransactionAction("tok_expired_1");

    expect(result.status).toBe("FAILED");
    // Should NOT call Transbank at all
    expect(mockGateway._commitTransactionMock).not.toHaveBeenCalled();
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
    const { default: logger } = await import("@/shared/lib/logger");
    const loggerSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await abortTransactionAction("tbk_token_123", "NONEXISTENT");

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ buyOrder: "NONEXISTENT" }),
      expect.stringContaining("buyOrder not found"),
    );
    loggerSpy.mockRestore();
  });

  it("does nothing when transaction is already terminal", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.markAsAuthorized({
      authorizationCode: "AUTH001",
      paymentTypeCode: "VD",
      installmentsNumber: 1,
      installmentsAmount: 5000,
      responseCode: 0,
      vci: "TSO",
      accountingDate: "0101",
      transactionDate: "2026-01-01T00:00:00.000Z",
    });
    seed(tx);

    await abortTransactionAction("tbk_token_123", "BO123");

    const updated = mockRepoStore.get(tx.props.id);
    expect(updated!.props.status).toBe("AUTHORIZED");
  });
});

describe("initiateTransactionAction", () => {
  describe("Happy path", () => {
    it("creates transaction, persists to DB, calls Transbank, and returns redirect data", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "tbk_new_token_123",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      const result = await initiateTransactionAction(5000);

      // Verify redirect data returned for POST form submission
      expect(result).toEqual({
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
        token: "tbk_new_token_123",
      });

      // Verify transaction was persisted
      const allTx = Array.from(mockRepoStore.values());
      expect(allTx).toHaveLength(1);
      const tx = allTx[0];
      expect(tx.props.amount).toBe(5000);
      expect(tx.props.status).toBe("INITIALIZED");
      expect(tx.props.token).toBe("tbk_new_token_123");
    });

    it("generates unique buy_order with BO prefix", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "token_1",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      await initiateTransactionAction(5000);

      const allTx = Array.from(mockRepoStore.values());
      expect(allTx[0].props.buyOrder).toMatch(/^BO[A-F0-9]{20}$/);
    });
  });

  describe("Amount validation", () => {
    it("throws when amount is zero", async () => {
      await expect(initiateTransactionAction(0)).rejects.toThrow("Invalid amount");
    });

    it("throws when amount is negative", async () => {
      await expect(initiateTransactionAction(-1000)).rejects.toThrow("Invalid amount");
    });

    it("accepts maximum valid amount (999,999,999)", async () => {
      mockGateway._createTransactionMock.mockResolvedValueOnce({
        token: "token_max",
        url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
      });

      const result = await initiateTransactionAction(999_999_999);

      expect(result.token).toBe("token_max");
      const allTx = Array.from(mockRepoStore.values());
      expect(allTx[0].props.amount).toBe(999_999_999);
    });
  });

  describe("Transbank failure", () => {
    it("marks transaction as FAILED and throws when Transbank rejects", async () => {
      mockGateway._createTransactionMock.mockRejectedValueOnce(new Error("Transbank down"));

      await expect(initiateTransactionAction(5000)).rejects.toThrow("Error initiating payment");

      const allTx = Array.from(mockRepoStore.values());
      expect(allTx).toHaveLength(1);
      expect(allTx[0].props.status).toBe("FAILED");
    });

    it("persists transaction BEFORE calling Transbank (traceability)", async () => {
      // First call: Transbank fails
      mockGateway._createTransactionMock.mockRejectedValueOnce(new Error("Transbank down"));

      await expect(initiateTransactionAction(5000)).rejects.toThrow("Error initiating payment");

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

  describe("Race condition with return handler", () => {
    it("does NOT overwrite if return handler processes between guard #1 and save", async () => {
      // Scenario: poll worker reads stale INITIALIZED transaction, calls Transbank,
      // but while waiting, the return handler processes the same transaction (marking AUTHORIZED).
      // The poll worker should NOT overwrite the return handler's state.
      const tx = WebpayTransaction.initialize("BO-RACE-1", "session-1", 5000);
      tx.setToken("tok_race_1");
      tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
      seed(tx);

      // Transbank says AUTHORIZED (poll worker's perspective)
      mockGateway._getTransactionStatusMock.mockImplementationOnce(async () => {
        // Simulate return handler processing this transaction WHILE we wait
        // This mutates the store so guard #2 sees a terminal state
        const stored = mockRepoStore.get(tx.props.id);
        if (stored) {
          stored.markAsAuthorized({
            authorizationCode: "AUTH-RACE",
            paymentTypeCode: "VD",
            installmentsNumber: 1,
            responseCode: 0,
            transactionDate: "2026-01-01T00:00:00.000Z",
          });
        }
        return {
          vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO-RACE-1",
          session_id: "session-1", accounting_date: "0101",
          transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
          payment_type_code: "VD", response_code: 0, installments_number: 1,
        };
      });

      const result = await pollStaleTransactionsAction();

      // Should have processed but NOT overwritten return handler's state
      expect(result.processed).toBe(1);
      expect(result.authorized).toBe(0); // skipped — return handler already won

      const updated = mockRepoStore.get(tx.props.id);
      // Return handler's auth code should be preserved, NOT poll worker's
      expect(updated!.props.authCode).toBe("AUTH-RACE");
    });
  });
});

// ─── Audit Trail Tests ────────────────────────────────────────────────────────

describe("Audit trail — verify all 4 fields stored correctly", () => {
  it("stores vci, cardNumber (last 4), accountingDate, transactionDate from commit", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_1");
    seed(tx);

    mockGateway._commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "1225",
      transaction_date: "2026-12-25T15:30:00.000Z", authorization_code: "AUTH999",
      payment_type_code: "VN", response_code: 0, installments_number: 3,
      card_detail: { card_number: "4444333322221111" },
    });

    const result = await confirmTransactionAction("tok_audit_1");

    expect(result.vci).toBe("TSO");
    expect(result.cardNumber).toBe("1111"); // last 4 of "4444333322221111"
    expect(result.accountingDate).toBe("1225");
    expect(result.transactionDate).toBeInstanceOf(Date);
    expect(result.transactionDate?.toISOString()).toBe("2026-12-25T15:30:00.000Z");
  });

  it("stores audit trail from 422 fallback (getTransactionStatus)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_2");
    seed(tx);

    mockGateway._commitTransactionMock.mockRejectedValueOnce(
      new TransbankAlreadyProcessedError("tok_audit_2"),
    );
    mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0615",
      transaction_date: "2026-06-15T10:00:00.000Z", authorization_code: "AUTH422",
      payment_type_code: "VD", response_code: 0, installments_number: 1,
      card_detail: { card_number: "5555666677778888" },
    });

    const result = await confirmTransactionAction("tok_audit_2");

    expect(result.vci).toBe("TSO");
    expect(result.cardNumber).toBe("8888");
    expect(result.accountingDate).toBe("0615");
    expect(result.transactionDate).toBeInstanceOf(Date);
  });

  it("stores audit trail from polling worker", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_3");
    tx.props.createdAt = new Date(Date.now() - 15 * 60 * 1000);
    seed(tx);

    mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0320",
      transaction_date: "2026-03-20T08:45:00.000Z", authorization_code: "AUTHPOLL",
      payment_type_code: "VN", response_code: 0, installments_number: 6,
      card_detail: { card_number: "9999888877776666" },
    });

    await pollStaleTransactionsAction();

    const updated = mockRepoStore.get(tx.props.id);
    expect(updated!.props.vci).toBe("TSO");
    expect(updated!.props.cardNumber).toBe("6666");
    expect(updated!.props.accountingDate).toBe("0320");
    expect(updated!.props.transactionDate).toBeInstanceOf(Date);
  });

  it("handles missing card_detail gracefully (cardNumber remains undefined)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_4");
    seed(tx);

    mockGateway._commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
      payment_type_code: "VD", response_code: 0, installments_number: 1,
      // No card_detail
    });

    const result = await confirmTransactionAction("tok_audit_4");

    expect(result.cardNumber).toBeUndefined();
    expect(result.vci).toBe("TSO");
  });

  it("normalizes empty card_number to undefined (not empty string)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_5");
    seed(tx);

    mockGateway._commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
      payment_type_code: "VD", response_code: 0, installments_number: 1,
      card_detail: { card_number: "" },
    });

    const result = await confirmTransactionAction("tok_audit_5");

    expect(result.cardNumber).toBeUndefined();
  });

  it("normalizes null vci to undefined", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_6");
    seed(tx);

    mockGateway._commitTransactionMock.mockResolvedValueOnce({
      vci: null, amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0101",
      transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
      payment_type_code: "VD", response_code: 0, installments_number: 1,
    });

    const result = await confirmTransactionAction("tok_audit_6");

    expect(result.vci).toBeUndefined();
  });

  it("marks FAILED when transactionDate is invalid (domain rejects it)", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_audit_7");
    seed(tx);

    mockGateway._commitTransactionMock.mockResolvedValueOnce({
      vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO123",
      session_id: "session-1", accounting_date: "0101",
      transaction_date: "not-a-real-date", authorization_code: "AUTH001",
      payment_type_code: "VD", response_code: 0, installments_number: 1,
    });

    // Domain throws Invalid Date → caught by outer catch → marks FAILED
    const result = await confirmTransactionAction("tok_audit_7");

    expect(result.status).toBe("FAILED");
  });
});

// ─── Audit Log Assertions ──────────────────────────────────────────────────

describe("Audit logging", () => {
  const auditLogMock = vi.mocked(prisma.transactionAuditLog.create);

  beforeEach(() => {
    auditLogMock.mockClear();
  });

  it("logs INITIALIZED on initiateTransactionAction", async () => {
    mockGateway._createTransactionMock.mockResolvedValueOnce({
      token: "tbk_init_audit_1",
      url: "https://webpay3g.transbank.cl/webpayserver/init_transaction",
    });

    await initiateTransactionAction(5000);

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "INITIALIZED",
          buyOrder: expect.stringContaining("BO"),
          transactionId: expect.any(String),
        }),
      }),
    );
  });

  it("logs MARKED_FAILED when Transbank rejects on initiate", async () => {
    mockGateway._createTransactionMock.mockRejectedValueOnce(new Error("Transbank down"));

    await expect(initiateTransactionAction(5000)).rejects.toThrow("Error initiating payment");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "MARKED_FAILED",
        }),
      }),
    );
  });

  it("logs AUTHORIZED on confirmTransactionAction", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_confirm_audit_1");
    seed(tx);

    mockCommitAuthorized();

    await confirmTransactionAction("tok_confirm_audit_1");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "AUTHORIZED",
          buyOrder: "BO123",
          transactionId: expect.any(String),
        }),
      }),
    );
  });

  it("logs REJECTED on confirmTransactionAction when bank rejects", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_confirm_audit_2");
    seed(tx);

    mockCommitRejected(-1);

    await confirmTransactionAction("tok_confirm_audit_2");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "REJECTED",
          buyOrder: "BO123",
          transactionId: expect.any(String),
        }),
      }),
    );
  });

  it("logs ABORTED on abortTransactionAction", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    seed(tx);

    await abortTransactionAction("tbk_token_123", "BO123");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "ABORTED",
          buyOrder: "BO123",
          transactionId: expect.any(String),
        }),
      }),
    );
  });

  it("logs MARKED_FAILED when confirmTransactionAction fallback fails", async () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 5000);
    tx.setToken("tok_confirm_audit_3");
    seed(tx);

    mockGateway._commitTransactionMock.mockRejectedValueOnce(
      new TransbankAlreadyProcessedError("tok_confirm_audit_3"),
    );
    mockGateway._getTransactionStatusMock.mockRejectedValueOnce(new Error("Network error"));

    await confirmTransactionAction("tok_confirm_audit_3");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: "MARKED_FAILED",
          buyOrder: "BO123",
          transactionId: expect.any(String),
        }),
      }),
    );
  });
});

// ─── refundTransactionAction ────────────────────────────────────────────────

describe("refundTransactionAction", () => {
  describe("Happy path (refund succeeds)", () => {
    it("transitions AUTHORIZED → REVERSED on successful refund", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-001", "session-1", 5000);
      tx.setToken("tok_refund_001");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      mockGateway.requestRefund.mockResolvedValueOnce({
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-001",
        authorization_date: "2026-01-01T00:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      });

      const result = await refundTransactionAction("tok_refund_001", 5000);

      expect(result.status).toBe("REVERSED");
      expect(mockGateway.requestRefund).toHaveBeenCalledWith("tok_refund_001", 5000);
    });

    it("saves transaction to DB before calling Transbank (persist-before-network)", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-002", "session-1", 5000);
      tx.setToken("tok_refund_002");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      // Make Transbank call fail to verify DB was saved before the call
      mockGateway.requestRefund.mockRejectedValueOnce(new Error("Network error"));

      try {
        await refundTransactionAction("tok_refund_002", 5000);
      } catch {
        // Expected to throw
      }

      // Transaction should still be AUTHORIZED in DB (not marked REVERSED on error)
      const saved = mockRepoStore.get(tx.props.id);
      expect(saved?.props.status).toBe("AUTHORIZED");
    });
  });

  describe("Idempotency (already REVERSED)", () => {
    it("returns current state without calling Transbank if already REVERSED", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-003", "session-1", 5000);
      tx.setToken("tok_refund_003");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      tx.markAsReversed();
      seed(tx);

      const result = await refundTransactionAction("tok_refund_003", 5000);

      expect(result.status).toBe("REVERSED");
      expect(mockGateway.requestRefund).not.toHaveBeenCalled();
    });

    it("returns current state without calling Transbank if already FAILED", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-004", "session-1", 5000);
      tx.setToken("tok_refund_004");
      tx.markAsFailed();
      seed(tx);

      const result = await refundTransactionAction("tok_refund_004", 5000);

      expect(result.status).toBe("FAILED");
      expect(mockGateway.requestRefund).not.toHaveBeenCalled();
    });
  });

  describe("Invalid state (not AUTHORIZED)", () => {
    it("throws if transaction is INITIALIZED", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-005", "session-1", 5000);
      tx.setToken("tok_refund_005");
      seed(tx);

      await expect(refundTransactionAction("tok_refund_005", 5000)).rejects.toThrow(
        "Only AUTHORIZED transactions can be reversed",
      );
      expect(mockGateway.requestRefund).not.toHaveBeenCalled();
    });

    it("throws if transaction is REJECTED", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-006", "session-1", 5000);
      tx.setToken("tok_refund_006");
      tx.markAsRejected(-1);
      seed(tx);

      await expect(refundTransactionAction("tok_refund_006", 5000)).rejects.toThrow(
        "Only AUTHORIZED transactions can be reversed",
      );
      expect(mockGateway.requestRefund).not.toHaveBeenCalled();
    });
  });

  describe("422 handling (already processed by Transbank)", () => {
    it("falls back to getTransactionStatus on TransbankRefundAlreadyProcessedError", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-007", "session-1", 5000);
      tx.setToken("tok_refund_007");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      // Simulate 422 from Transbank
      mockGateway.requestRefund.mockRejectedValueOnce(
        new TransbankRefundAlreadyProcessedError("tok_refund_007"),
      );

      // Fallback: getTransactionStatus shows it's already REVERSED
      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "REVERSED", buy_order: "BO-REFUND-007",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
        payment_type_code: "VD", response_code: 0, installments_number: 1,
      });

      const result = await refundTransactionAction("tok_refund_007", 5000);

      expect(result.status).toBe("REVERSED");
      expect(mockGateway._getTransactionStatusMock).toHaveBeenCalledWith("tok_refund_007");
    });

    it("marks as REVERSED if getTransactionStatus shows AUTHORIZED (refund succeeded but status unknown)", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-008", "session-1", 5000);
      tx.setToken("tok_refund_008");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      mockGateway.requestRefund.mockRejectedValueOnce(
        new TransbankRefundAlreadyProcessedError("tok_refund_008"),
      );

      // Fallback: getTransactionStatus still shows AUTHORIZED
      // This is an edge case — refund was processed but status hasn't updated yet
      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "AUTHORIZED", buy_order: "BO-REFUND-008",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
        payment_type_code: "VD", response_code: 0, installments_number: 1,
      });

      const result = await refundTransactionAction("tok_refund_008", 5000);

      // Should NOT mark as REVERSED if status is still AUTHORIZED
      // This is ambiguous — leave for manual intervention
      expect(result.status).toBe("AUTHORIZED");
    });
  });

  describe("Timeout handling", () => {
    it("does NOT mark as REVERSED on timeout — leaves for manual intervention", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-009", "session-1", 5000);
      tx.setToken("tok_refund_009");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      // Simulate timeout (AbortError)
      const timeoutError = new DOMException("The operation was aborted", "AbortError");
      mockGateway.requestRefund.mockRejectedValueOnce(timeoutError);

      const result = await refundTransactionAction("tok_refund_009", 5000);

      // Should stay AUTHORIZED — not REVERSED (we don't know if Transbank processed it)
      expect(result.status).toBe("AUTHORIZED");
    });

    it("does NOT mark as REVERSED on network error", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-010", "session-1", 5000);
      tx.setToken("tok_refund_010");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      mockGateway.requestRefund.mockRejectedValueOnce(new Error("fetch failed"));

      const result = await refundTransactionAction("tok_refund_010", 5000);

      expect(result.status).toBe("AUTHORIZED");
    });
  });

  describe("Audit logging", () => {
    it("logs REVERSED on successful refund", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-011", "session-1", 5000);
      tx.setToken("tok_refund_011");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      mockGateway.requestRefund.mockResolvedValueOnce({
        type: "REVERSED",
        authorization_code: "AUTH-REFUND-011",
        authorization_date: "2026-01-01T00:00:00.000Z",
        nullified_amount: 5000,
        balance: 0,
        response_code: 0,
      });

      await refundTransactionAction("tok_refund_011", 5000);

      expect(vi.mocked(prisma.transactionAuditLog.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: "REVERSED",
            buyOrder: "BO-REFUND-011",
            transactionId: expect.any(String),
          }),
        }),
      );
    });

    it("logs REVERSED on 422 fallback when status is REVERSED", async () => {
      const tx = WebpayTransaction.initialize("BO-REFUND-012", "session-1", 5000);
      tx.setToken("tok_refund_012");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        responseCode: 0,
        transactionDate: "2026-01-01T00:00:00.000Z",
      });
      seed(tx);

      mockGateway.requestRefund.mockRejectedValueOnce(
        new TransbankRefundAlreadyProcessedError("tok_refund_012"),
      );
      mockGateway._getTransactionStatusMock.mockResolvedValueOnce({
        vci: "TSO", amount: 5000, status: "REVERSED", buy_order: "BO-REFUND-012",
        session_id: "session-1", accounting_date: "0101",
        transaction_date: "2026-01-01T00:00:00.000Z", authorization_code: "AUTH001",
        payment_type_code: "VD", response_code: 0, installments_number: 1,
      });

      await refundTransactionAction("tok_refund_012", 5000);

      expect(vi.mocked(prisma.transactionAuditLog.create)).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            event: "REVERSED",
            buyOrder: "BO-REFUND-012",
          }),
        }),
      );
    });
  });

  describe("Transaction not found", () => {
    it("throws if token not found in DB", async () => {
      await expect(refundTransactionAction("tok_nonexistent", 5000)).rejects.toThrow(
        "Transaction not found",
      );
      expect(mockGateway.requestRefund).not.toHaveBeenCalled();
    });
  });
});
