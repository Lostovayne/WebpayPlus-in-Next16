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
 * Stale entries are cleaned up lazily on each check to prevent unbounded growth.
 */
export class MemoryRateLimitGateway implements RateLimitGateway {
  private readonly store = new Map<string, WindowEntry>();

  async check(key: string, window: string, limit: number): Promise<RateLimitResult> {
    const windowMs = parseWindow(window);
    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    // Remove timestamps outside the current window (sliding window eviction)
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    // Remove empty entries to prevent unbounded memory growth
    if (entry.timestamps.length === 0) {
      this.store.delete(key);
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    const remaining = Math.max(0, limit - entry.timestamps.length);
    const success = entry.timestamps.length < limit;

    if (success) {
      entry.timestamps.push(now);
    }

    // Calculate when the oldest request in the window expires
    const reset = entry.timestamps.length > 0
      ? Math.ceil((entry.timestamps[0] + windowMs) / 1000)
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
