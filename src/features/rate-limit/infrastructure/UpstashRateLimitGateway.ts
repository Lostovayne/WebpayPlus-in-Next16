import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { RateLimitGateway, RateLimitResult } from "../domain/RateLimitGateway";

/**
 * Parse a human-readable window string into milliseconds.
 *
 * Supported formats:
 * - "10 s"  → 10_000 ms
 * - "1 m"   → 60_000 ms
 * - "1 h"   → 3_600_000 ms
 *
 * Defaults to seconds if no unit suffix is provided.
 */
function parseWindow(window: string): number {
  const trimmed = window.trim();
  const match = trimmed.match(/^(\d+)\s*(s|m|h)?$/);

  if (!match) {
    throw new Error(`[UpstashRateLimitGateway] Invalid window format: "${window}". Expected "N s", "N m", or "N h".`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "s";

  const multipliers: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };
  return value * multipliers[unit];
}

/**
 * Upstash Redis adapter for rate limiting.
 *
 * Uses sliding window algorithm via @upstash/ratelimit.
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.
 *
 * Each check() call creates a scoped Ratelimit instance for the given
 * window+limit combination. This is correct for Upstash because the
 * limiter config is baked into the instance — you can't change max/window
 * per request on the same instance.
 */
export class UpstashRateLimitGateway implements RateLimitGateway {
  private readonly redis: Redis;

  constructor() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        "[UpstashRateLimitGateway] Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN.",
      );
    }

    this.redis = new Redis({ url, token });
  }

  async check(key: string, window: string, limit: number): Promise<RateLimitResult> {
    const windowMs = parseWindow(window);

    const ratelimit = new Ratelimit({
      redis: this.redis,
      limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
      analytics: false,
    });

    const result = await ratelimit.limit(key);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: Math.ceil(result.reset / 1000), // Convert ms → epoch seconds
    };
  }
}
