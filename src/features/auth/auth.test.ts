import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks (BEFORE imports) ───────────────────────────────────────────────────

const mockBetterAuth = vi.fn((config) => ({ ...config, _type: "betterAuth" }));

vi.mock("better-auth", () => ({
  betterAuth: mockBetterAuth,
}));

vi.mock("@/shared/env", () => ({
  env: {
    BETTER_AUTH_URL: "https://auth.example.com",
    BETTER_AUTH_SECRET: "super-secret-key-at-least-32-chars-long!!",
    NEXT_PUBLIC_APP_URL: "https://example.com",
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
  },
}));

vi.mock("@/shared/lib/prisma", () => ({
  prisma: { _mock: true },
}));

vi.mock("@/shared/lib/logger", () => ({
  default: {
    error: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter: vi.fn(() => ({ type: "prismaAdapter" })),
}));

vi.mock("better-auth/plugins/two-factor", () => ({
  twoFactor: vi.fn((config) => ({ name: "twoFactor", config })),
}));

vi.mock("better-auth/plugins/multi-session", () => ({
  multiSession: vi.fn(() => ({ name: "multiSession" })),
}));

vi.mock("./infrastructure/upstash-secondary-storage", () => ({
  createUpstashSecondaryStorage: vi.fn((url, token) => ({
    type: "upstash",
    url,
    token,
  })),
}));

vi.mock("./infrastructure/email-service", () => ({
  sendVerificationEmail: vi.fn(),
  sendOTPEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("auth configuration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Re-register mocks after resetModules
    vi.doMock("better-auth", () => ({ betterAuth: mockBetterAuth }));
    vi.doMock("@/shared/env", () => ({
      env: {
        BETTER_AUTH_URL: "https://auth.example.com",
        BETTER_AUTH_SECRET: "super-secret-key-at-least-32-chars-long!!",
        NEXT_PUBLIC_APP_URL: "https://example.com",
        UPSTASH_REDIS_REST_URL: undefined,
        UPSTASH_REDIS_REST_TOKEN: undefined,
      },
    }));
    vi.doMock("@/shared/lib/prisma", () => ({ prisma: { _mock: true } }));
    vi.doMock("@/shared/lib/logger", () => ({
      default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock("better-auth/adapters/prisma", () => ({
      prismaAdapter: vi.fn(() => ({ type: "prismaAdapter" })),
    }));
    vi.doMock("better-auth/plugins/two-factor", () => ({
      twoFactor: vi.fn((config) => ({ name: "twoFactor", config })),
    }));
    vi.doMock("better-auth/plugins/multi-session", () => ({
      multiSession: vi.fn(() => ({ name: "multiSession" })),
    }));
    vi.doMock("./infrastructure/upstash-secondary-storage", () => ({
      createUpstashSecondaryStorage: vi.fn((url, token) => ({
        type: "upstash",
        url,
        token,
      })),
    }));
    vi.doMock("./infrastructure/email-service", () => ({
      sendVerificationEmail: vi.fn(),
      sendOTPEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn(),
    }));
  });

  async function loadAuth() {
    const { twoFactor: tf } = await import("better-auth/plugins/two-factor");
    const { multiSession: ms } = await import(
      "better-auth/plugins/multi-session"
    );
    const { prismaAdapter: pa } = await import("better-auth/adapters/prisma");
    const { createUpstashSecondaryStorage: cups } = await import(
      "./infrastructure/upstash-secondary-storage"
    );
    const { betterAuth } = await import("better-auth");
    await import("./auth");
    return {
      betterAuth,
      twoFactor: tf,
      multiSession: ms,
      prismaAdapter: pa,
      createUpstashSecondaryStorage: cups,
    };
  }

  describe("BetterAuth is configured correctly", () => {
    it("calls betterAuth with correct baseURL", async () => {
      const { betterAuth } = await loadAuth();

      expect(betterAuth).toHaveBeenCalledOnce();
      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.baseURL).toBe("https://auth.example.com");
    });

    it("configures appName", async () => {
      const { betterAuth } = await loadAuth();

      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.appName).toBe("Webpay Plus");
    });

    it("configures session with correct expiresIn", async () => {
      const { betterAuth } = await loadAuth();

      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.session).toBeDefined();
      expect(config.session!.expiresIn).toBe(60 * 60 * 24 * 7); // 7 days
    });

    it("configures emailAndPassword with correct settings", async () => {
      const { betterAuth } = await loadAuth();

      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.emailAndPassword).toBeDefined();
      expect(config.emailAndPassword!.enabled).toBe(true);
      expect(config.emailAndPassword!.requireEmailVerification).toBe(true);
      expect(config.emailAndPassword!.minPasswordLength).toBe(8);
      expect(config.emailAndPassword!.maxPasswordLength).toBe(128);
    });
  });

  describe("plugins", () => {
    it("registers twoFactor plugin", async () => {
      const { twoFactor } = await loadAuth();

      expect(twoFactor).toHaveBeenCalledOnce();
      const pluginConfig = vi.mocked(twoFactor).mock.calls[0][0];
      expect(pluginConfig.issuer).toBe("Webpay Plus");
      expect(pluginConfig.otpOptions?.period).toBe(5);
      expect(pluginConfig.otpOptions?.digits).toBe(6);
      expect(pluginConfig.otpOptions?.allowedAttempts).toBe(5);
    });

    it("registers multiSession plugin", async () => {
      const { multiSession } = await loadAuth();

      expect(multiSession).toHaveBeenCalledOnce();
    });

    it("both plugins are in the plugins array", async () => {
      const { betterAuth } = await loadAuth();

      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.plugins).toBeDefined();
      expect(config.plugins!.length).toBe(2);
    });
  });

  describe("secondaryStorage", () => {
    it("is not configured when UPSTASH env vars are missing", async () => {
      const { betterAuth, createUpstashSecondaryStorage } = await loadAuth();

      const config = vi.mocked(betterAuth).mock.calls[0][0];
      expect(config.secondaryStorage).toBeUndefined();
      expect(createUpstashSecondaryStorage).not.toHaveBeenCalled();
    });
  });

  describe("prismaAdapter", () => {
    it("is called with postgresql provider", async () => {
      const { prismaAdapter } = await loadAuth();

      expect(prismaAdapter).toHaveBeenCalledOnce();
      const [, options] = vi.mocked(prismaAdapter).mock.calls[0];
      expect(options).toEqual({ provider: "postgresql" });
    });
  });
});

describe("auth configuration with Upstash", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("configures secondaryStorage when UPSTASH env vars are set", async () => {
    vi.doMock("better-auth", () => ({ betterAuth: mockBetterAuth }));
    vi.doMock("@/shared/env", () => ({
      env: {
        BETTER_AUTH_URL: "https://auth.example.com",
        BETTER_AUTH_SECRET: "super-secret-key-at-least-32-chars-long!!",
        NEXT_PUBLIC_APP_URL: "https://example.com",
        UPSTASH_REDIS_REST_URL: "https://upstash.io/redis",
        UPSTASH_REDIS_REST_TOKEN: "upstash-token-123",
      },
    }));
    vi.doMock("@/shared/lib/prisma", () => ({ prisma: { _mock: true } }));
    vi.doMock("@/shared/lib/logger", () => ({
      default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock("better-auth/adapters/prisma", () => ({
      prismaAdapter: vi.fn(() => ({ type: "prismaAdapter" })),
    }));
    vi.doMock("better-auth/plugins/two-factor", () => ({
      twoFactor: vi.fn((config) => ({ name: "twoFactor", config })),
    }));
    vi.doMock("better-auth/plugins/multi-session", () => ({
      multiSession: vi.fn(() => ({ name: "multiSession" })),
    }));
    vi.doMock("./infrastructure/upstash-secondary-storage", () => ({
      createUpstashSecondaryStorage: vi.fn((url, token) => ({
        type: "upstash",
        url,
        token,
      })),
    }));
    vi.doMock("./infrastructure/email-service", () => ({
      sendVerificationEmail: vi.fn(),
      sendOTPEmail: vi.fn(),
      sendPasswordResetEmail: vi.fn(),
    }));

    const { createUpstashSecondaryStorage } = await import(
      "./infrastructure/upstash-secondary-storage"
    );
    const { betterAuth } = await import("better-auth");
    await import("./auth");

    expect(createUpstashSecondaryStorage).toHaveBeenCalledWith(
      "https://upstash.io/redis",
      "upstash-token-123",
    );

    const config = vi.mocked(betterAuth).mock.calls[0][0];
    expect(config.secondaryStorage).toBeDefined();
  });
});
