import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins/two-factor";
import { multiSession } from "better-auth/plugins/multi-session";
import { prisma } from "@/shared/lib/prisma";
import { env } from "@/shared/env";
import { createUpstashSecondaryStorage } from "./infrastructure/upstash-secondary-storage";

/**
 * BetterAuth configuration for Webpay Plus integration.
 *
 * Plugins enabled:
 * - emailAndPassword: Basic credential authentication
 * - twoFactor: TOTP + OTP via email for MFA
 * - multiSession: Allow multiple concurrent sessions per user
 *
 * Storage:
 * - Primary: PostgreSQL via Prisma (shared client)
 * - Secondary: Upstash Redis for sessions + rate limiting
 */
export const auth = betterAuth({
  appName: "Webpay Plus",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  // Database adapter — reuse shared PrismaClient (no duplicate connection pool)
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  // Session configuration
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // Refresh every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
      strategy: "compact",
    },
  },

  // Email and password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true, // CRITICAL: must verify email ownership
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url, token }, request) => {
      // TODO: Implement email sending with Resend before production deploy
      // SECURITY: Never log the token or URL in production
      if (process.env.NODE_ENV === "development") {
        console.debug(`[Auth] Password reset requested for ${user.email}`);
      }
    },
  },

  // Plugins
  plugins: [
    twoFactor({
      issuer: "Webpay Plus",
      otpOptions: {
        period: 5, // 5 minutes
        digits: 6,
        allowedAttempts: 5,
        storeOTP: "encrypted",
        sendOTP: async ({ user, otp }, ctx) => {
          // TODO: Implement OTP email sending with Resend before production deploy
          // SECURITY: Never log the OTP in production
          if (process.env.NODE_ENV === "development") {
            console.debug(`[Auth] OTP requested for ${user.email}`);
          }
        },
      },
      backupCodeOptions: {
        amount: 10,
        length: 10,
        storeBackupCodes: "encrypted",
      },
      twoFactorCookieMaxAge: 600, // 10 minutes
      trustDeviceMaxAge: 30 * 24 * 60 * 60, // 30 days
    }),
    multiSession(),
  ],

  // Secondary storage — Upstash Redis for sessions + rate limiting on serverless
  ...(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? {
        secondaryStorage: createUpstashSecondaryStorage(
          env.UPSTASH_REDIS_REST_URL,
          env.UPSTASH_REDIS_REST_TOKEN,
        ),
      }
    : {}),

  // Rate limiting (production by default)
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
    storage: env.UPSTASH_REDIS_REST_URL ? "secondary-storage" : undefined,
    customRules: {
      "/api/auth/sign-in/email": { window: 60, max: 5 },
      "/api/auth/sign-up/email": { window: 60, max: 3 },
    },
  },

  // Advanced security settings
  advanced: {
    useSecureCookies: env.BETTER_AUTH_URL.startsWith("https"),
    defaultCookieAttributes: {
      sameSite: "lax",
    },
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
    },
  },

  // Trusted origins
  trustedOrigins: [env.NEXT_PUBLIC_APP_URL],
});

export type Auth = typeof auth;
