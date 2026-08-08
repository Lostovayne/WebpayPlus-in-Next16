import { NextResponse } from "next/server";
import { prisma } from "@/shared/lib/prisma";
import { env } from "@/shared/env";
import logger from "@/shared/lib/logger";

/**
 * GET /api/health
 *
 * Health check endpoint for monitoring and post-deploy verification.
 * Checks:
 * 1. Environment variables (Transbank credentials present)
 * 2. Database connectivity (Prisma ping)
 *
 * Returns 200 if healthy, 503 if any check fails.
 */
export async function GET() {
  const checks: Record<string, boolean> = {};
  const details: Record<string, string> = {};
  let allHealthy = true;

  // Check 1: Environment variables
  const hasTransbankCreds =
    Boolean(env.WEBPAY_COMMERCE_CODE) && Boolean(env.WEBPAY_API_SECRET);
  checks.transbank_credentials = hasTransbankCreds;
  if (!hasTransbankCreds) {
    details.transbank_credentials = "Missing WEBPAY_COMMERCE_CODE or WEBPAY_API_SECRET";
    allHealthy = false;
  }

  // Check 2: Database connectivity
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = true;
  } catch (err) {
    checks.database = false;
    details.database =
      err instanceof Error ? err.message : "Database connection failed";
    allHealthy = false;
    logger.error({ err }, "[Health] Database check failed");
  }

  const status = allHealthy ? "ok" : "degraded";

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      checks,
      ...(Object.keys(details).length > 0 && { details }),
    },
    { status: allHealthy ? 200 : 503 },
  );
}
