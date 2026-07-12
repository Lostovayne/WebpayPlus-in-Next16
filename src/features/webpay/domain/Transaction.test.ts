import { describe, it, expect } from "vitest";
import {
  WebpayTransaction,
  WebpayCommitData,
  TransactionStatus,
} from "./Transaction";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTransaction(overrides?: { status?: TransactionStatus }) {
  const tx = WebpayTransaction.initialize(
    "BO123456789012345678",
    "session-1",
    5000,
  );
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
    expect(() => WebpayTransaction.initialize("BO123", "s", 0)).toThrow(
      "greater than zero",
    );
    expect(() => WebpayTransaction.initialize("BO123", "s", -100)).toThrow(
      "greater than zero",
    );
  });

  it("rejects amount > 999,999,999", () => {
    expect(() =>
      WebpayTransaction.initialize("BO123", "s", 1_000_000_000),
    ).toThrow("exceeds Transbank CLP limit");
  });

  it("rejects buy_order > 26 chars", () => {
    expect(() =>
      WebpayTransaction.initialize("A".repeat(27), "s", 1000),
    ).toThrow("buy_order is invalid");
  });

  it("accepts buy_order with Transbank allowed special characters", () => {
    const tx = WebpayTransaction.initialize("ORD|123=A", "s", 1000);
    expect(tx.props.buyOrder).toBe("ORD|123=A");
  });

  it("accepts buy_order exactly 26 chars", () => {
    const tx = WebpayTransaction.initialize("A".repeat(26), "s", 1000);
    expect(tx.props.buyOrder).toHaveLength(26);
  });

  it("rejects session_id > 61 chars (Transbank limit)", () => {
    expect(() =>
      WebpayTransaction.initialize("BO123", "x".repeat(62), 1000),
    ).toThrow("61 characters");
  });

  it("accepts session_id exactly 61 chars", () => {
    const tx = WebpayTransaction.initialize("BO123", "x".repeat(61), 1000);
    expect(tx.props.sessionId).toHaveLength(61);
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
      expect(() => tx.setToken("tok_abc123")).toThrow('requires "INITIALIZED"');
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
      expect(tx.props.transactionDate?.toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });

    it("handles optional cardNumber (undefined when not provided by Transbank)", () => {
      const tx = createTransaction();
      tx.markAsAuthorized({
        ...validCommitData,
        cardNumber: undefined,
      });

      expect(tx.props.cardNumber).toBeUndefined();
    });

    it("throws when cardNumber exceeds 4 digits (PCI DSS violation)", () => {
      const tx = createTransaction();
      expect(() =>
        tx.markAsAuthorized({
          ...validCommitData,
          cardNumber: "12345",
        }),
      ).toThrow("cardNumber must be at most 4 digits");
    });

    it("throws when transactionDate is invalid ISO string", () => {
      const tx = createTransaction();
      expect(() =>
        tx.markAsAuthorized({
          ...validCommitData,
          transactionDate: "not-a-date",
        }),
      ).toThrow("Invalid transactionDate");
    });

    it("throws when transactionDate is empty string", () => {
      const tx = createTransaction();
      expect(() =>
        tx.markAsAuthorized({
          ...validCommitData,
          transactionDate: "",
        }),
      ).toThrow("Invalid transactionDate");
    });

    it("throws when not INITIALIZED", () => {
      const tx = createTransaction({ status: "AUTHORIZED" });
      expect(() => tx.markAsAuthorized(validCommitData)).toThrow(
        'requires "INITIALIZED"',
      );
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
      expect(() => tx.markAsRejected(-1)).toThrow('requires "INITIALIZED"');
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
      expect(() => tx.markAsAbortedByClient("reason")).toThrow(
        'requires "INITIALIZED"',
      );
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
      expect(() => tx.markAsFailed()).toThrow(
        'Cannot mark FAILED: transaction is in "AUTHORIZED"',
      );
    });

    it("throws when REJECTED (preserves rejection reason)", () => {
      const tx = createTransaction({ status: "REJECTED" });
      expect(() => tx.markAsFailed()).toThrow(
        'Cannot mark FAILED: transaction is in "REJECTED"',
      );
    });

    it("throws when ABORTED (preserves abort reason)", () => {
      const tx = createTransaction({ status: "ABORTED" });
      expect(() => tx.markAsFailed()).toThrow(
        'Cannot mark FAILED: transaction is in "ABORTED"',
      );
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
      expect(() => tx.markAsReversed()).toThrow(
        "Only AUTHORIZED transactions can be reversed",
      );
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

// ─── isTokenExpired ─────────────────────────────────────────────────────────

describe("isTokenExpired", () => {
  it("returns false when token was just created", () => {
    const tx = createTransaction();
    expect(tx.isTokenExpired).toBe(false);
  });

  it("returns true when created > 5 minutes ago", () => {
    const tx = createTransaction();
    // Simulate creation 6 minutes ago
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    Object.defineProperty(tx.props, "createdAt", {
      value: new Date(sixMinutesAgo),
      writable: false,
    });
    expect(tx.isTokenExpired).toBe(true);
  });

  it("returns false for non-INITIALIZED transactions regardless of age", () => {
    const tx = createTransaction({ status: "AUTHORIZED" });
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    Object.defineProperty(tx.props, "createdAt", {
      value: new Date(sixMinutesAgo),
      writable: false,
    });
    expect(tx.isTokenExpired).toBe(false);
  });

  it("returns false exactly at 5 minutes (boundary)", () => {
    const tx = createTransaction();
    const exactlyFiveMinutes = Date.now() - 5 * 60 * 1000;
    Object.defineProperty(tx.props, "createdAt", {
      value: new Date(exactlyFiveMinutes),
      writable: false,
    });
    // Exactly at boundary: elapsed = TOKEN_TTL_MS, NOT >, so NOT expired
    expect(tx.isTokenExpired).toBe(false);
  });

  it("returns true one millisecond after 5 minutes", () => {
    const tx = createTransaction();
    const fiveMinutesPlusOne = Date.now() - (5 * 60 * 1000 + 1);
    Object.defineProperty(tx.props, "createdAt", {
      value: new Date(fiveMinutesPlusOne),
      writable: false,
    });
    expect(tx.isTokenExpired).toBe(true);
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
    expect(() => tx.markAsAuthorized(validCommitData)).toThrow(
      'requires "INITIALIZED"',
    );
  });

  it("blocks markAsFailed after markAsRejected (preserves terminal state)", () => {
    const tx = createTransaction();
    tx.markAsRejected(-1);
    expect(() => tx.markAsFailed()).toThrow(
      'Cannot mark FAILED: transaction is in "REJECTED"',
    );
  });
});
