import { Prisma } from "generated/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { Decimal } = Prisma;

// Mock external dependencies BEFORE imports
vi.mock("@/shared/lib/prisma", () => ({
  prisma: {
    webpayTransaction: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/shared/lib/prisma";
import { WebpayTransaction } from "../domain/Transaction";
import { PrismaTransactionRepository } from "./PrismaTransactionRepository";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createPrismaRecord(
  overrides?: Partial<
    Parameters<PrismaTransactionRepository["save"]>[0]["props"]
  >,
) {
  return {
    id: "tx-001",
    buyOrder: "BO-123",
    sessionId: "session-abc",
    amount: new Decimal(5000),
    status: "INITIALIZED",
    token: "tok-123",
    paymentUrl:
      "https://webpay3gint.transbank.cl/webpayserver/init_transaction",
    vci: "TSO",
    cardNumber: "1234",
    accountingDate: "0101",
    transactionDate: new Date("2025-06-27T10:00:00Z"),
    authCode: "AUTH001",
    paymentTypeCode: "VD",
    installmentsAmount: new Decimal(5000),
    installmentsNumber: 1,
    responseCode: 0,
    abortedReason: null,
    polledAt: null,
    createdAt: new Date("2025-06-27T09:55:00Z"),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PrismaTransactionRepository", () => {
  let repo: PrismaTransactionRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new PrismaTransactionRepository();
  });

  // ─── findByToken ────────────────────────────────────────────────────────────

  describe("findByToken", () => {
    it("returns null when no record is found", async () => {
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        null as never,
      );

      const result = await repo.findByToken("nonexistent-token");

      expect(result).toBeNull();
      expect(prisma.webpayTransaction.findUnique).toHaveBeenCalledWith({
        where: { token: "nonexistent-token" },
      });
    });

    it("returns a domain entity when a record is found", async () => {
      const record = createPrismaRecord();
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result).toBeInstanceOf(WebpayTransaction);
      expect(result!.props.id).toBe("tx-001");
      expect(result!.props.buyOrder).toBe("BO-123");
      expect(result!.props.amount).toBe(5000);
      expect(result!.props.status).toBe("INITIALIZED");
      expect(result!.props.token).toBe("tok-123");
    });
  });

  // ─── findByBuyOrder ─────────────────────────────────────────────────────────

  describe("findByBuyOrder", () => {
    it("returns null when no record is found", async () => {
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        null as never,
      );

      const result = await repo.findByBuyOrder("BO-nonexistent");

      expect(result).toBeNull();
      expect(prisma.webpayTransaction.findUnique).toHaveBeenCalledWith({
        where: { buyOrder: "BO-nonexistent" },
      });
    });

    it("returns a domain entity when found", async () => {
      const record = createPrismaRecord({ buyOrder: "BO-999" });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByBuyOrder("BO-999");

      expect(result).toBeInstanceOf(WebpayTransaction);
      expect(result!.props.buyOrder).toBe("BO-999");
    });
  });

  // ─── save ───────────────────────────────────────────────────────────────────

  describe("save", () => {
    it("calls upsert with correct data on create", async () => {
      vi.mocked(prisma.webpayTransaction.upsert).mockResolvedValue({} as never);

      const tx = WebpayTransaction.initialize("BO-123", "session-abc", 5000);
      tx.setToken("tok-new");

      await repo.save(tx);

      expect(prisma.webpayTransaction.upsert).toHaveBeenCalledOnce();
      const call = vi.mocked(prisma.webpayTransaction.upsert).mock.calls[0][0];

      expect(call.where).toEqual({ id: tx.props.id });
      expect(call.create.id).toBe(tx.props.id);
      expect(call.create.buyOrder).toBe("BO-123");
      expect(call.create.sessionId).toBe("session-abc");
      expect(call.create.amount).toBe(5000);
      expect(call.create.status).toBe("INITIALIZED");
      expect(call.create.token).toBe("tok-new");
    });

    it("calls upsert with update fields on save", async () => {
      vi.mocked(prisma.webpayTransaction.upsert).mockResolvedValue({} as never);

      const tx = WebpayTransaction.initialize("BO-123", "session-abc", 5000);
      tx.setToken("tok-1");
      tx.markAsAuthorized({
        authorizationCode: "AUTH001",
        paymentTypeCode: "VD",
        installmentsNumber: 1,
        installmentsAmount: 5000,
        responseCode: 0,
        vci: "TSO",
        cardNumber: "1234",
        accountingDate: "0101",
        transactionDate: "2025-06-27T10:00:00Z",
      });

      await repo.save(tx);

      const call = vi.mocked(prisma.webpayTransaction.upsert).mock.calls[0][0];
      expect(call.update.status).toBe("AUTHORIZED");
      expect(call.update.authCode).toBe("AUTH001");
      expect(call.update.cardNumber).toBe("1234");
    });

    it("propagates Prisma errors", async () => {
      vi.mocked(prisma.webpayTransaction.upsert).mockRejectedValue(
        new Error("Database connection lost"),
      );

      const tx = WebpayTransaction.initialize("BO-123", "session-abc", 5000);

      await expect(repo.save(tx)).rejects.toThrow("Database connection lost");
    });
  });

  // ─── toDomain mapper (via findByToken) ──────────────────────────────────────

  describe("toDomain mapper", () => {
    it("maps INITIALIZED status correctly", async () => {
      const record = createPrismaRecord({ status: "INITIALIZED" });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("INITIALIZED");
    });

    it("maps AUTHORIZED status correctly", async () => {
      const record = createPrismaRecord({
        status: "AUTHORIZED",
        authCode: "AUTH001",
        cardNumber: "1234",
        transactionDate: new Date("2025-06-27T10:00:00Z"),
      });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("AUTHORIZED");
      expect(result!.props.authCode).toBe("AUTH001");
      expect(result!.props.cardNumber).toBe("1234");
    });

    it("maps REJECTED status correctly", async () => {
      const record = createPrismaRecord({ status: "REJECTED" });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("REJECTED");
    });

    it("maps ABORTED status correctly", async () => {
      const record = createPrismaRecord({
        status: "ABORTED",
        abortedReason: "User cancelled",
      });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("ABORTED");
      expect(result!.props.abortedReason).toBe("User cancelled");
    });

    it("maps FAILED status correctly", async () => {
      const record = createPrismaRecord({ status: "FAILED" });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("FAILED");
    });

    it("maps REVERSED status correctly", async () => {
      const record = createPrismaRecord({ status: "REVERSED" });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.status).toBe("REVERSED");
    });

    it("throws on invalid status from DB", async () => {
      const record = createPrismaRecord({ status: "CORRUPTED" } as never);
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      await expect(repo.findByToken("tok-123")).rejects.toThrow(
        'Corrupted transaction status in DB: "CORRUPTED" for id=tx-001',
      );
    });

    it("handles null optional fields (token, authCode, cardNumber, etc.)", async () => {
      const record = createPrismaRecord({
        token: null,
        authCode: null,
        cardNumber: null,
        vci: null,
        accountingDate: null,
        transactionDate: null,
        paymentTypeCode: null,
        installmentsAmount: null,
        installmentsNumber: null,
        responseCode: null,
        abortedReason: null,
        polledAt: null,
        paymentUrl: null,
      });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(result!.props.token).toBeUndefined();
      expect(result!.props.authCode).toBeUndefined();
      expect(result!.props.cardNumber).toBeUndefined();
      expect(result!.props.vci).toBeUndefined();
      expect(result!.props.accountingDate).toBeUndefined();
      expect(result!.props.transactionDate).toBeUndefined();
      expect(result!.props.paymentTypeCode).toBeUndefined();
      expect(result!.props.installmentsAmount).toBeUndefined();
      expect(result!.props.installmentsNumber).toBeUndefined();
      expect(result!.props.responseCode).toBeUndefined();
      expect(result!.props.abortedReason).toBeUndefined();
      expect(result!.props.polledAt).toBeUndefined();
      expect(result!.props.paymentUrl).toBeUndefined();
    });

    it("converts Decimal amounts to numbers", async () => {
      const record = createPrismaRecord({
        amount: new Decimal(99999.99),
        installmentsAmount: new Decimal(33333.33),
      });
      vi.mocked(prisma.webpayTransaction.findUnique).mockResolvedValue(
        record as never,
      );

      const result = await repo.findByToken("tok-123");

      expect(typeof result!.props.amount).toBe("number");
      expect(result!.props.amount).toBe(99999.99);
      expect(typeof result!.props.installmentsAmount).toBe("number");
      expect(result!.props.installmentsAmount).toBe(33333.33);
    });
  });

  // ─── findStaleInitialized ───────────────────────────────────────────────────

  describe("findStaleInitialized", () => {
    it("queries with correct cutoff and pollCutoff", async () => {
      vi.mocked(prisma.webpayTransaction.findMany).mockResolvedValue([]);
      const now = Date.now();

      await repo.findStaleInitialized(10);

      expect(prisma.webpayTransaction.findMany).toHaveBeenCalledOnce();
      const call = vi.mocked(prisma.webpayTransaction.findMany).mock
        .calls[0][0];

      expect(call.where).toEqual({
        status: "INITIALIZED",
        createdAt: { lt: expect.any(Date) },
        OR: [{ polledAt: null }, { polledAt: { lt: expect.any(Date) } }],
      });
      expect(call.orderBy).toEqual({ createdAt: "asc" });
      expect(call.take).toBe(50);

      // Verify createdAt cutoff is roughly 10 minutes ago (within 1s tolerance)
      const createdAtCutoff = (call.where as never).createdAt.lt as Date;
      const diff = now - createdAtCutoff.getTime();
      expect(diff).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1000);
      expect(diff).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

      // Verify polledAt cutoff is roughly 5 minutes ago
      const polledAtCutoff = ((call.where as never).OR[1] as never).polledAt
        .lt as Date;
      const pollDiff = now - polledAtCutoff.getTime();
      expect(pollDiff).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
      expect(pollDiff).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    });

    it("returns mapped domain entities", async () => {
      const records = [
        createPrismaRecord({ id: "tx-1", buyOrder: "BO-1" }),
        createPrismaRecord({ id: "tx-2", buyOrder: "BO-2" }),
      ];
      vi.mocked(prisma.webpayTransaction.findMany).mockResolvedValue(
        records as never,
      );

      const results = await repo.findStaleInitialized(10);

      expect(results).toHaveLength(2);
      expect(results[0]).toBeInstanceOf(WebpayTransaction);
      expect(results[1]).toBeInstanceOf(WebpayTransaction);
      expect(results[0].props.id).toBe("tx-1");
      expect(results[1].props.id).toBe("tx-2");
    });

    it("returns empty array when no stale transactions exist", async () => {
      vi.mocked(prisma.webpayTransaction.findMany).mockResolvedValue([]);

      const results = await repo.findStaleInitialized(10);

      expect(results).toEqual([]);
    });

    it("propagates Prisma errors", async () => {
      vi.mocked(prisma.webpayTransaction.findMany).mockRejectedValue(
        new Error("Query timeout"),
      );

      await expect(repo.findStaleInitialized(10)).rejects.toThrow(
        "Query timeout",
      );
    });
  });
});
