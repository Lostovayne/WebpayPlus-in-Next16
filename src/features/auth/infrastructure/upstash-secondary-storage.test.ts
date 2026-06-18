import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUpstashSecondaryStorage } from "./upstash-secondary-storage";

describe("UpstashSecondaryStorage", () => {
  const mockUrl = "https://example.upstash.io";
  const mockToken = "test-token";

  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockUpstashResponse(data: unknown) {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }

  function mockUpstashError(status: number, body: string) {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    });
  }

  function expectFetchRequest(body: unknown[]) {
    expect(fetchSpy).toHaveBeenCalledWith(mockUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mockToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  // ─── get() ────────────────────────────────────────────────────────────────

  describe("get", () => {
    it("returns value when key exists", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["session-data"]);

      const result = await storage.get("session-abc");

      expect(result).toBe("session-data");
      expectFetchRequest(["GET", "session-abc"]);
    });

    it("returns null when key does not exist", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse([null]);

      const result = await storage.get("nonexistent");

      expect(result).toBeNull();
    });
  });

  // ─── set() ────────────────────────────────────────────────────────────────

  describe("set", () => {
    it("sets value without TTL", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["OK"]);

      await storage.set("key-1", "value-1");

      expectFetchRequest(["SET", "key-1", "value-1"]);
    });

    it("sets value with TTL", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["OK"]);

      await storage.set("key-2", "value-2", 300);

      expectFetchRequest(["SET", "key-2", "value-2", "EX", "300"]);
    });

    it("ignores TTL when zero or negative", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["OK"]);

      await storage.set("key-3", "value-3", 0);

      expectFetchRequest(["SET", "key-3", "value-3"]);
    });
  });

  // ─── delete() ─────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("deletes key", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(1);

      await storage.delete("key-to-delete");

      expectFetchRequest(["DEL", "key-to-delete"]);
    });
  });

  // ─── increment() ──────────────────────────────────────────────────────────

  describe("increment", () => {
    it("increments counter and sets EXPIRE on first increment", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse([1]); // First increment → value becomes 1
      mockUpstashResponse(["OK"]); // EXPIRE call

      const result = await storage.increment("rate-limit-key", 60);

      expect(result).toBe(1);
      // First call: INCR
      expect(fetchSpy.mock.calls[0][1].body).toBe(
        JSON.stringify(["INCR", "rate-limit-key"]),
      );
      // Second call: EXPIRE (because result was 1)
      expect(fetchSpy.mock.calls[1][1].body).toBe(
        JSON.stringify(["EXPIRE", "rate-limit-key", "60"]),
      );
    });

    it("increments without EXPIRE on subsequent increments", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse([5]); // Value is 5 (not first increment)

      const result = await storage.increment("rate-limit-key", 60);

      expect(result).toBe(5);
      // Only one call (INCR), no EXPIRE
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("does not set EXPIRE when TTL is zero", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse([1]);

      const result = await storage.increment("counter", 0);

      expect(result).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── getAndDelete() ───────────────────────────────────────────────────────

  describe("getAndDelete", () => {
    it("returns value and deletes atomically", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["otp-code-123"]);

      const result = await storage.getAndDelete("verification:otp");

      expect(result).toBe("otp-code-123");
      expectFetchRequest(["GETDEL", "verification:otp"]);
    });

    it("returns null when key does not exist", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse([null]);

      const result = await storage.getAndDelete("nonexistent");

      expect(result).toBeNull();
    });
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  describe("error handling", () => {
    it("throws on non-OK response", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashError(500, "Internal Server Error");

      await expect(storage.get("key")).rejects.toThrow(
        "Upstash Redis error: 500 Internal Server Error",
      );
    });

    it("throws on network failure", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(storage.get("key")).rejects.toThrow("fetch failed");
    });
  });

  // ─── Request format ───────────────────────────────────────────────────────

  describe("request format", () => {
    it("sends correct headers", async () => {
      const storage = createUpstashSecondaryStorage(mockUrl, mockToken);
      mockUpstashResponse(["OK"]);

      await storage.set("k", "v");

      expect(fetchSpy).toHaveBeenCalledWith(
        mockUrl,
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: `Bearer ${mockToken}`,
            "Content-Type": "application/json",
          },
        }),
      );
    });
  });
});
