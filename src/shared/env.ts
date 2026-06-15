import { z } from "zod";

const envSchema = z.object({
  WEBPAY_COMMERCE_CODE: z.string().min(1, "WEBPAY_COMMERCE_CODE is missing"),
  WEBPAY_API_SECRET: z.string().min(1, "WEBPAY_API_SECRET is missing"),
  WEBPAY_ENVIRONMENT: z.enum(["integration", "production"]).default("integration"),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be a valid URL")
    .default("http://localhost:3000"),
  // Secret compartido entre Vercel Cron y el endpoint de polling.
  CRON_SECRET: z.string().min(32, "CRON_SECRET debe tener al menos 32 caracteres"),
  // BetterAuth
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().url("BETTER_AUTH_URL must be a valid URL").default("http://localhost:3000"),
  // Upstash (secondary storage for BetterAuth sessions)
  UPSTASH_REDIS_REST_URL: z.string().url("UPSTASH_REDIS_REST_URL must be a valid URL").optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1, "UPSTASH_REDIS_REST_TOKEN is missing").optional(),
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
});

if (!parsedEnv.success) {
  console.error(" Invalid environment variables:", z.treeifyError(parsedEnv.error));
  throw new Error("Terminating due to invalid environment variables");
}

export const env = parsedEnv.data;
