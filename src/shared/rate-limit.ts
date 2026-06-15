import { NextRequest, NextResponse } from "next/server";
import type { RateLimitGateway } from "@/features/rate-limit/domain/RateLimitGateway";
import { MemoryRateLimitGateway } from "@/features/rate-limit/infrastructure/MemoryRateLimitGateway";

// ─── Singleton Gateway ──────────────────────────────────────────────────────

let gateway: RateLimitGateway | null = null;

async function getGateway(): Promise<RateLimitGateway> {
  if (gateway) return gateway;

  const hasUpstash =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  if (hasUpstash) {
    // Dynamic import — only loads @upstash packages when actually needed
    const { UpstashRateLimitGateway } = await import(
      "@/features/rate-limit/infrastructure/UpstashRateLimitGateway"
    );
    gateway = new UpstashRateLimitGateway();
  } else {
    gateway = new MemoryRateLimitGateway();
  }

  return gateway;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_WINDOW = "1 m";
const DEFAULT_LIMIT = 60;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract client IP from request headers.
 *
 * In production behind a reverse proxy (Vercel, Cloudflare, nginx),
 * the real client IP is in x-forwarded-for. In local dev, fall back
 * to a deterministic identifier.
 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;

  // Local dev fallback — not suitable for production
  return "127.0.0.1";
}

/**
 * Check rate limit for a given key and return a 429 response if exceeded.
 *
 * @returns NextResponse — either the handler result or a 429 response.
 */
export async function rateLimitOrProceed(
  req: NextRequest,
  key: string,
  window = DEFAULT_WINDOW,
  limit = DEFAULT_LIMIT,
  handler?: () => NextResponse | Promise<NextResponse>,
): Promise<NextResponse> {
  const gw = await getGateway();
  const result = await gw.check(key, window, limit);

  if (!result.success) {
    const retryAfter = Math.max(0, result.reset - Math.floor(Date.now() / 1000));

    return NextResponse.json(
      {
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": String(result.remaining),
          "X-RateLimit-Reset": String(result.reset),
        },
      },
    );
  }

  // Rate limit passed — invoke the handler if provided
  if (handler) {
    const response = await handler();
    response.headers.set("X-RateLimit-Limit", String(result.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));
    response.headers.set("X-RateLimit-Reset", String(result.reset));
    return response;
  }

  // No handler — return success with rate limit headers
  return new NextResponse(null, {
    status: 200,
    headers: {
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.reset),
    },
  });
}
