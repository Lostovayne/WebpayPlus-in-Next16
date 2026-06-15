import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins/two-factor";
import { multiSession } from "better-auth/plugins/multi-session";
import { PrismaClient } from "generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@/shared/env";

const connectionString = `${env.DATABASE_URL}`;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

/**
 * BetterAuth configuration for Webpay Plus integration.
 *
 * Plugins enabled:
 * - emailAndPassword: Basic credential authentication
 * - twoFactor: TOTP + OTP via email for MFA
 * - multiSession: Allow multiple concurrent sessions per user
 *
 * Storage:
 * - Primary: PostgreSQL via Prisma
 * - Secondary: Upstash Redis for sessions (if configured)
 */
export const auth = betterAuth({
  appName: "Webpay Plus",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,

  // Database adapter
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
    requireEmailVerification: false, // Enable in production
    minPasswordLength: 8,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url, token }, request) => {
      // TODO: Implement email sending with Resend
      console.log(`[Auth] Password reset requested for ${user.email}: ${url}`);
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
          // TODO: Implement OTP email sending with Resend
          console.log(`[Auth] OTP for ${user.email}: ${otp}`);
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

  // Rate limiting (production by default)
  rateLimit: {
    enabled: true,
    window: 10,
    max: 100,
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
