import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Set required env vars before any imports
process.env.WEBPAY_COMMERCE_CODE = "597055555532";
process.env.WEBPAY_API_SECRET = "test-secret-min-32-characters-long";
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
process.env.CRON_SECRET = "a".repeat(32);
process.env.BETTER_AUTH_SECRET = "a".repeat(32);
process.env.RESEND_API_KEY = "re_test_key";

// Mock Resend before importing email-service
const mockSend = vi.fn();
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: mockSend };
    constructor(_apiKey: string) {}
  },
}));

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSend.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 5 times before throwing (exponential backoff cap now reachable)", async () => {
    mockSend.mockRejectedValue(new Error("Network error"));

    const { sendVerificationEmail } = await import("./email-service");
    const promise = sendVerificationEmail("test@example.com", "http://localhost/verify");

    // Attach handler immediately to prevent Vitest unhandled rejection detection
    promise.catch(() => {});

    // Delays: 1s, 2s, 4s, 8s (capped at 10s)
    await vi.advanceTimersByTimeAsync(15000);

    await expect(promise).rejects.toThrow("Network error");
    expect(mockSend).toHaveBeenCalledTimes(5);
  });

  it("succeeds on first attempt without retry", async () => {
    mockSend.mockResolvedValue({ id: "email-123" });

    const { sendVerificationEmail } = await import("./email-service");
    await sendVerificationEmail("test@example.com", "http://localhost/verify");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second attempt after one retry", async () => {
    mockSend
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ id: "email-123" });

    const { sendVerificationEmail } = await import("./email-service");
    const promise = sendVerificationEmail("test@example.com", "http://localhost/verify");
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
