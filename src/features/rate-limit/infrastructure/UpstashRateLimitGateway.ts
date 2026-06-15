import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { RateLimitGateway, RateLimitResult } from "../domain/RateLimitGateway";
import { parseWindow } from "../domain/parseWindow";

/**
 * Upstash Redis adapter for rate limiting.
 *
 * Uses sliding window algorithm via @upstash/ratelimit.
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars.
 *
 * Caches Ratelimit instances by window+limit combination to avoid
 * re-creating identical limiters on every request.
 */
export class UpstashRateLimitGateway implements RateLimitGateway {
  private readonly redis: Redis;
  private readonly limiters = new Map<string, Ratelimit>();

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

    // Cache Ratelimit instance by window+limit to avoid per-request allocation
    const cacheKey = `${windowMs}:${limit}`;
    let ratelimit = this.limiters.get(cacheKey);

    if (!ratelimit) {
      ratelimit = new Ratelimit({
        redis: this.redis,
        limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`),
        analytics: false,
      });
      this.limiters.set(cacheKey, ratelimit);
    }

    const result = await ratelimit.limit(key);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: Math.ceil(result.reset / 1000), // Convert ms → epoch seconds
    };
  }
}
