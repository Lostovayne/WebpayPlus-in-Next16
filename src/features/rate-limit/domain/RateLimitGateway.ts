/**
 * Result of a rate limit check.
 *
 * Follows the standard rate limit response contract:
 * - `success`: whether the request is allowed
 * - `limit`: max requests allowed in the window
 * - `remaining`: requests left in the current window
 * - `reset`: UTC epoch seconds when the window resets
 */
export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

/**
 * Domain interface for rate limiting.
 *
 * Swappable by design: the application layer depends on this contract,
 * not on Upstash, memory, or any specific implementation.
 * Infrastructure adapters implement this interface.
 */
export interface RateLimitGateway {
  check(key: string, window: string, limit: number): Promise<RateLimitResult>;
}
