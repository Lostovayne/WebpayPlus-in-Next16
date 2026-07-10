import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("env validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.WEBPAY_COMMERCE_CODE = "597055555532";
    process.env.WEBPAY_API_SECRET = "test-secret-min-32-characters-long";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/db";
    process.env.CRON_SECRET = "a".repeat(32);
    process.env.BETTER_AUTH_SECRET = "a".repeat(32);
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when BETTER_AUTH_URL is missing in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BETTER_AUTH_URL;

    await expect(import("@/shared/env")).rejects.toThrow(
      "BETTER_AUTH_URL is required in production"
    );
  });

  it("does not throw when BETTER_AUTH_URL is missing in test environment", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.BETTER_AUTH_URL;

    const { env } = await import("@/shared/env");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });

  it("does not throw when BETTER_AUTH_URL is missing in development", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.BETTER_AUTH_URL;

    const { env } = await import("@/shared/env");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });
});
