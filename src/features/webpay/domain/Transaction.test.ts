import { describe, it, expect } from "vitest";
import {
  WebpayTransaction,
  WebpayCommitData,
  TransactionStatus,
} from "./Transaction";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTransaction(overrides?: { status?: TransactionStatus }) {
  const tx = WebpayTransaction.initialize("BO123456789012345678", "session-1", 5000);
  if (overrides?.status) {
    applyStatus(tx, overrides.status);
  }
  return tx;
}

function applyStatus(tx: WebpayTransaction, status: TransactionStatus) {
  switch (status) {
    case "INITIALIZED":
      break; // Already initialized
    case "AUTHORIZED":
      tx.markAsAuthorized(validCommitData);
      break;
    case "REJECTED":
      tx.markAsRejected(-1);
      break;
    case "ABORTED":
      tx.markAsAbortedByClient("User cancelled");
      break;
    case "FAILED":
      tx.markAsFailed();
      break;
    case "REVERSED":
      tx.markAsAuthorized(validCommitData);
      tx.markAsReversed();
      break;
  }
}

const validCommitData: WebpayCommitData = {
  authorizationCode: "AUTH001",
  paymentTypeCode: "VD",
  installmentsNumber: 1,
  installmentsAmount: 5000,
  responseCode: 0,
  // Audit trail
  vci: "TSO",
  cardNumber: "1234",
  accountingDate: "0101",
  transactionDate: "2026-01-01T00:00:00.000Z",
};

// ─── Factory Method ───────────────────────────────────────────────────────────

describe("WebpayTransaction.initialize", () => {
  it("creates a transaction in INITIALIZED state", () => {
    const tx = WebpayTransaction.initialize("BO123", "session-1", 1000);

    expect(tx.props.status).toBe("INITIALIZED");
    expect(tx.props.buyOrder).toBe("BO123");
    expect(tx.props.sessionId).toBe("session-1");
    expect(tx.props.amount).toBe(1000);
    expect(tx.props.id).toBeDefined();
    expect(tx.props.token).toBeUndefined();
  });

  it("rejects amount <= 0", () => {
    expect(() => WebpayTransaction.initialize("BO123", "s", 0)).toThrow("mayor a cero");
    expect(() => WebpayTransaction.initialize("BO123", "s", -100)).toThrow("mayor a cero");
  });

  it("rejects amount > 999,999,999", () => {
    expect(() => WebpayTransaction.initialize("BO123", "s", 1_000_000_000)).toThrow(
      "supera el máximo",
    );
  });

  it("rejects buy_order > 26 chars", () => {
    expect(() => WebpayTransaction.initialize("A".repeat(27), "s", 1000)).toThrow(
      "26 caracteres",
    );
  });

  it("accepts buy_order exactly 26 chars", () => {
    const tx = WebpayTransaction.initialize("A".repeat(26), "s", 1000);
    expect(tx.props.buyOrder).toHaveLength(26);
  });
});

// ─── State Transitions ────────────────────────────────────────────────────────

describe("State transitions", () => {
  describe("setToken", () => {
    it("sets token when INITIALIZED", () => {
      const tx = createTransaction();
      tx.setToken("tok_abc123");
      expect(tx.props.token).toBe("tok_abc123");
    });

    it("throws when not INITIALIZED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.setToken("tok_abc123")).toThrow("requiere estado \"INITIALIZED\"");
    });
  });

  describe("markAsAuthorized", () => {
    it("transitions INITIALIZED → AUTHORIZED", () => {
      const tx = createTransaction();
      tx.markAsAuthorized(validCommitData);

      expect(tx.props.status).toBe("AUTHORIZED");
      expect(tx.props.authCode).toBe("AUTH001");
      expect(tx.props.paymentTypeCode).toBe("VD");
      expect(tx.props.installmentsNumber).toBe(1);
      expect(tx.props.responseCode).toBe(0);
    });

    it("stores audit trail fields (vci, cardNumber, accountingDate, transactionDate)", () => {
      const tx = createTransaction();
      tx.markAsAuthorized(validCommitData);

      expect(tx.props.vci).toBe("TSO");
      expect(tx.props.cardNumber).toBe("1234");
      expect(tx.props.accountingDate).toBe("0101");
      expect(tx.props.transactionDate).toBeInstanceOf(Date);
      expect(tx.props.transactionDate?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    });

    it("handles optional cardNumber (undefined when not provided by Transbank)", () => {
      const tx = createTransaction();
      tx.markAsAuthorized({
        ...validCommitData,
        cardNumber: undefined,
      });

      expect(tx.props.cardNumber).toBeUndefined();
    });

    it("throws when not INITIALIZED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.markAsAuthorized(validCommitData)).toThrow("requiere estado \"INITIALIZED\"");
    });
  });

  describe("markAsRejected", () => {
    it("transitions INITIALIZED → REJECTED", () => {
      const tx = createTransaction();
      tx.markAsRejected(-1);

      expect(tx.props.status).toBe("REJECTED");
      expect(tx.props.responseCode).toBe(-1);
    });

    it("throws when not INITIALIZED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.markAsRejected(-1)).toThrow("requiere estado \"INITIALIZED\"");
    });
  });

  describe("markAsAbortedByClient", () => {
    it("transitions INITIALIZED → ABORTED", () => {
      const tx = createTransaction();
      tx.markAsAbortedByClient("User cancelled");

      expect(tx.props.status).toBe("ABORTED");
      expect(tx.props.abortedReason).toBe("User cancelled");
    });

    it("truncates reason to 50 chars", () => {
      const tx = createTransaction();
      tx.markAsAbortedByClient("A".repeat(100));

      expect(tx.props.abortedReason).toHaveLength(50);
    });

    it("throws when not INITIALIZED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.markAsAbortedByClient("reason")).toThrow("requiere estado \"INITIALIZED\"");
    });
  });

  describe("markAsFailed", () => {
    it("transitions INITIALIZED → FAILED", () => {
      const tx = createTransaction();
      tx.markAsFailed();
      expect(tx.props.status).toBe("FAILED");
    });

    it("throws when AUTHORIZED (cannot rollback)", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.markAsFailed()).toThrow("No se puede marcar FAILED una transacción ya AUTHORIZED");
    });
  });

  describe("markAsReversed", () => {
    it("transitions AUTHORIZED → REVERSED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      tx.markAsReversed();
      expect(tx.props.status).toBe("REVERSED");
    });

    it("throws when not AUTHORIZED", () => {
      const tx = createTransaction();
      expect(() => tx.markAsReversed()).toThrow("Solo se puede revertir una transacción AUTHORIZED");
    });
  });

  describe("markAsPolled", () => {
    it("sets polledAt timestamp", () => {
      const tx = createTransaction();
      expect(tx.props.polledAt).toBeUndefined();

      tx.markAsPolled();
      expect(tx.props.polledAt).toBeInstanceOf(Date);
    });
  });
});

// ─── isTerminal ────────────────────────────────────────────────────────────────

describe("isTerminal", () => {
  it("returns true for AUTHORIZED, REJECTED, ABORTED, FAILED, REVERSED", () => {
    const terminals: TransactionStatus[] = [
      "AUTHORIZED",
      "REJECTED",
      "ABORTED",
      "FAILED",
      "REVERSED",
    ];

    for (const status of terminals) {
      const tx = createTransaction({ status });
      expect(tx.isTerminal).toBe(true);
    }
  });

  it("returns false for INITIALIZED", () => {
    const tx = createTransaction();
    expect(tx.isTerminal).toBe(false);
  });
});

// ─── Invalid Transitions ──────────────────────────────────────────────────────

describe("Invalid transitions", () => {
  it("can setToken multiple times (state remains INITIALIZED)", () => {
    const tx = createTransaction();
    tx.setToken("tok1");
    tx.setToken("tok2");
    expect(tx.props.token).toBe("tok2");
  });

  it("cannot markAsAuthorized after markAsRejected", () => {
    const tx = createTransaction();
    tx.markAsRejected(-1);
    expect(() => tx.markAsAuthorized(validCommitData)).toThrow("requiere estado \"INITIALIZED\"");
  });

  it("allows markAsFailed after markAsRejected (only blocks AUTHORIZED)", () => {
    const tx = createTransaction();
    tx.markAsRejected(-1);
    // markAsFailed doesn't check for REJECTED specifically, only blocks AUTHORIZED
    tx.markAsFailed();
    expect(tx.props.status).toBe("FAILED");
  });
});
