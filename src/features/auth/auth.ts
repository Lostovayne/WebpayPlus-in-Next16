import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins/two-factor";
import { multiSession } from "better-auth/plugins/multi-session";
import { prisma } from "@/shared/lib/prisma";
import logger from "@/shared/lib/logger";
import { env } from "@/shared/env";
import { createUpstashSecondaryStorage } from "./infrastructure/upstash-secondary-storage";
import {
  sendVerificationEmail,
  sendOTPEmail,
  sendPasswordResetEmail,
} from "./infrastructure/email-service";

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
 *
 * Security:
 * - Email verification required before first login
 * - freshAge: 30 min for sensitive actions (password change, etc.)
 * - JWE cookie cache (encrypted, prevents tampering)
 * - sameSite: strict (stronger CSRF protection)
 * - databaseHooks: audit logging for session events
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
    freshAge: 60 * 30, // 30 minutes — re-auth required for sensitive actions
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
      strategy: "jwe", // JWE encrypted — prevents cookie tampering in payment context
    },
  },

  // Email and password authentication
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url, token }, request) => {
      await sendPasswordResetEmail(user.email, url);
    },
  },

  // Email verification
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url, token }, request) => {
      await sendVerificationEmail(user.email, url);
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
          await sendOTPEmail(user.email, otp);
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
      sameSite: "strict", // Stricter CSRF protection for payment-integrated auth
    },
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
    },
    // Serverless: ensure emails don't block response
    backgroundTasks: {
      handler: (promise) => {
        // Fire-and-forget: email sending shouldn't delay the response
        promise.catch((err) => {
          logger.error({ err }, "[Auth] Background task error");
        });
      },
    },
  },

  // Trusted origins
  trustedOrigins: [env.NEXT_PUBLIC_APP_URL],

  // Audit logging for security events
  databaseHooks: {
    session: {
      create: {
        after: async (session, ctx) => {
          logger.debug({
            event: "session.create",
            userId: session.userId,
            ipAddress: ctx?.request?.headers.get("x-forwarded-for"),
            userAgent: ctx?.request?.headers.get("user-agent"),
          }, "[Auth] Session created");
        },
      },
      delete: {
        after: async (session) => {
          logger.debug({
            event: "session.delete",
            sessionId: session.id,
            userId: session.userId,
          }, "[Auth] Session deleted");
        },
      },
    },
    user: {
      update: {
        after: async (user, ctx) => {
          logger.debug({
            event: "user.update",
            userId: user.id,
          }, "[Auth] User updated");
        },
      },
    },
  },
});

export type Auth = typeof auth;
