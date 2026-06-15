import type { RateLimitGateway, RateLimitResult } from "../domain/RateLimitGateway";
import { parseWindow } from "../domain/parseWindow";

interface WindowEntry {
  timestamps: number[];
}

/**
 * In-memory sliding window rate limiter for local development.
 *
 * No external dependencies. Uses a Map with timestamp arrays.
 * Suitable for single-instance local dev and tests — NOT for production
 * where requests may hit different instances.
 *
 * Stale entries are removed from the Map when their timestamps expire,
 * preventing unbounded memory growth.
 */
export class MemoryRateLimitGateway implements RateLimitGateway {
  private readonly store = new Map<string, WindowEntry>();

  async check(key: string, window: string, limit: number): Promise<RateLimitResult> {
    const windowMs = parseWindow(window);
    const now = Date.now();
    const windowStart = now - windowMs;

    const existing = this.store.get(key);

    // Remove timestamps outside the current window (sliding window eviction)
    const activeTimestamps = existing
      ? existing.timestamps.filter((ts) => ts > windowStart)
      : [];

    const remaining = Math.max(0, limit - activeTimestamps.length);
    const success = activeTimestamps.length < limit;

    if (success) {
      activeTimestamps.push(now);
    }

    // Only store if there are active timestamps; otherwise let the entry be garbage collected
    if (activeTimestamps.length > 0) {
      this.store.set(key, { timestamps: activeTimestamps });
    } else {
      this.store.delete(key);
    }

    // Calculate when the oldest request in the window expires
    const reset = activeTimestamps.length > 0
      ? Math.ceil((activeTimestamps[0] + windowMs) / 1000)
      : Math.ceil((now + windowMs) / 1000);

    return {
      success,
      limit,
      remaining: success ? remaining - 1 : remaining,
      reset,
    };
  }

  /** Reset all entries — useful for tests. */
  clear(): void {
    this.store.clear();
  }
}
