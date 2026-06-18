import { z } from "zod";
import pino from "pino";

const envSchema = z.object({
  WEBPAY_COMMERCE_CODE: z.string().min(1, "WEBPAY_COMMERCE_CODE is missing"),
  WEBPAY_API_SECRET: z.string().min(1, "WEBPAY_API_SECRET is missing"),
  WEBPAY_ENVIRONMENT: z.enum(["integration", "production"]).default("integration"),
  DATABASE_URL: z.url("DATABASE_URL must be a valid URL"),
  NEXT_PUBLIC_APP_URL: z
    .url("NEXT_PUBLIC_APP_URL must be a valid URL")
    .default("http://localhost:3000"),
  // Secret compartido entre Vercel Cron y el endpoint de polling.
  CRON_SECRET: z.string().min(32, "CRON_SECRET debe tener al menos 32 caracteres"),
  // BetterAuth
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a valid URL").optional(),
  // Upstash (secondary storage for BetterAuth sessions)
  UPSTASH_REDIS_REST_URL: z.url("UPSTASH_REDIS_REST_URL must be a valid URL").optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1, "UPSTASH_REDIS_REST_TOKEN is missing").optional(),
  // Resend (email service for auth emails) — optional in dev, required in production
  RESEND_API_KEY: z.string().min(1, "RESEND_API_KEY is missing").optional(),
  RESEND_FROM_EMAIL: z.string().email("RESEND_FROM_EMAIL must be a valid email").optional(),
});

const parsedEnv = envSchema.safeParse({
  WEBPAY_COMMERCE_CODE: process.env.WEBPAY_COMMERCE_CODE,
  WEBPAY_API_SECRET: process.env.WEBPAY_API_SECRET,
  WEBPAY_ENVIRONMENT: process.env.WEBPAY_ENVIRONMENT,
  DATABASE_URL: process.env.DATABASE_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  CRON_SECRET: process.env.CRON_SECRET,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
});

if (!parsedEnv.success) {
  pino().fatal({ err: z.treeifyError(parsedEnv.error) }, "Invalid environment variables");
  throw new Error("Terminating due to invalid environment variables");
}

const data = parsedEnv.data;

// Production-safe: BETTER_AUTH_URL must be explicitly set in production
if (!data.BETTER_AUTH_URL) {
  if (process.env.NODE_ENV === "development") {
    data.BETTER_AUTH_URL = "http://localhost:3000";
  } else {
    throw new Error("BETTER_AUTH_URL is required in production — no default allowed");
  }
}

// After post-parse validation, BETTER_AUTH_URL is guaranteed to be defined
export const env: Omit<typeof data, "BETTER_AUTH_URL"> & { BETTER_AUTH_URL: string } = data as any;
