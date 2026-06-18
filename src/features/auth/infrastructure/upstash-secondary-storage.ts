import type { SecondaryStorage } from "@better-auth/core/db";

/**
 * Upstash Redis adapter for BetterAuth SecondaryStorage.
 *
 * Wraps the Upstash Redis REST API to conform to BetterAuth's SecondaryStorage
 * interface (get/set/delete/increment). Used for session caching and rate limiting
 * in serverless environments where memory state resets on cold start.
 */
export function createUpstashSecondaryStorage(
  url: string,
  token: string,
): SecondaryStorage {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function request<T>(command: string[], ttl?: number): Promise<T> {
    const body = ttl !== undefined ? [...command, "EX", String(ttl)] : command;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Upstash Redis error: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    async get(key: string) {
      const result = await request<[string | null]>(["GET", key]);
      return result[0];
    },

    async set(key: string, value: string, ttl?: number) {
      if (ttl && ttl > 0) {
        await request<["OK"]>(["SET", key, value], ttl);
      } else {
        await request<["OK"]>(["SET", key, value]);
      }
    },

    async delete(key: string) {
      await request<number>(["DEL", key]);
    },

    async increment(key: string, ttl: number) {
      const result = await request<[number]>(["INCR", key]);
      // Set expiry only on first increment (when value becomes 1)
      if (result[0] === 1 && ttl > 0) {
        await request<["OK"]>(["EXPIRE", key, String(ttl)]);
      }
      return result[0];
    },

    async getAndDelete(key: string) {
      const result = await request<[string | null]>(["GETDEL", key]);
      return result[0];
    },
  };
}
