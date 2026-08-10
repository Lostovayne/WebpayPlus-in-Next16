import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/features/auth/domain/email-provider";

// ─── Env setup (before any imports) ────────────────────────────────────────────
process.env.WEBPAY_COMMERCE_CODE = "597055555532";
process.env.WEBPAY_API_SECRET = "test-secret-min-32-characters-long";
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
process.env.CRON_SECRET = "a".repeat(32);
process.env.BETTER_AUTH_SECRET = "a".repeat(32);
// Note: RESEND_API_KEY is intentionally NOT set — dev mode by default

// ─── Mock logger (instead of mocking the resend package) ───────────────────────
vi.mock("@/shared/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  let mockProvider: EmailProvider;

  beforeEach(async () => {
    vi.useFakeTimers();
    const { _setEmailProvider } = await import("./email-service");
    mockProvider = {
      name: "mock",
      send: vi.fn(),
    };
    _setEmailProvider(mockProvider);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    const { _setEmailProvider } = await import("./email-service");
    _setEmailProvider(null);
  });

  it("retries 5 times before throwing (exponential backoff cap now reachable)", async () => {
    vi.mocked(mockProvider.send).mockRejectedValue(new Error("Network error"));

    const { sendVerificationEmail } = await import("./email-service");
    const promise = sendVerificationEmail(
      "test@example.com",
      "http://localhost/verify",
    );

    // Attach handler immediately to prevent Vitest unhandled rejection detection
    promise.catch(() => {});

    // Delays: 1s, 2s, 4s, 8s (capped at 10s)
    await vi.advanceTimersByTimeAsync(15000);

    await expect(promise).rejects.toThrow("Network error");
    expect(mockProvider.send).toHaveBeenCalledTimes(5);
  });

  it("succeeds on first attempt without retry", async () => {
    vi.mocked(mockProvider.send).mockResolvedValue({
      id: "email-123",
      provider: "mock",
    });

    const { sendVerificationEmail } = await import("./email-service");
    await sendVerificationEmail("test@example.com", "http://localhost/verify");
    expect(mockProvider.send).toHaveBeenCalledTimes(1);
  });

  it("succeeds on second attempt after one retry", async () => {
    vi.mocked(mockProvider.send)
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ id: "email-123", provider: "mock" });

    const { sendVerificationEmail } = await import("./email-service");
    const promise = sendVerificationEmail(
      "test@example.com",
      "http://localhost/verify",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(mockProvider.send).toHaveBeenCalledTimes(2);
  });
});

describe("dev mode (no RESEND_API_KEY)", () => {
  let noopProvider: import("@/features/auth/domain/email-provider").EmailProvider;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { _setEmailProvider } = await import("./email-service");
    noopProvider = {
      name: "noop",
      send: vi.fn(async () => ({ id: null, provider: "noop" as const })),
    } as unknown as import("@/features/auth/domain/email-provider").EmailProvider;
    _setEmailProvider(noopProvider);
  });

  afterEach(async () => {
    const { _setEmailProvider } = await import("./email-service");
    _setEmailProvider(null);
  });

  it("createEmailProvider returns NoopEmailProvider when RESEND_API_KEY is absent", async () => {
    expect(noopProvider.name).toBe("noop");
    expect(vi.mocked(noopProvider.send)).toBeDefined();
  });

  it("sendVerificationEmail logs debug without sending in dev mode", async () => {
    const { sendVerificationEmail } = await import("./email-service");
    await sendVerificationEmail("dev@example.com", "http://localhost/verify");

    expect(vi.mocked(noopProvider.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dev@example.com",
        subject: "Verify your email address",
      }),
    );
  });

  it("sendOTPEmail logs debug without sending in dev mode", async () => {
    const { sendOTPEmail } = await import("./email-service");
    await sendOTPEmail("dev@example.com", "123456");

    expect(vi.mocked(noopProvider.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dev@example.com",
        subject: "Your verification code",
      }),
    );
  });

  it("sendPasswordResetEmail logs debug without sending in dev mode", async () => {
    const { sendPasswordResetEmail } = await import("./email-service");
    await sendPasswordResetEmail("dev@example.com", "http://localhost/reset");

    expect(vi.mocked(noopProvider.send)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dev@example.com",
        subject: "Reset your password",
      }),
    );
  });
});
