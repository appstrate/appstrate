// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy cookie jar — per-session persistent cookie storage
 * across successive proxyCall() invocations. Needed for multi-step
 * OAuth flows where a provider's first response sets a session cookie
 * that subsequent calls must carry back.
 *
 * Two backends:
 *   - `InMemoryCookieJarStore` — single-instance, Tier 0/1.
 *   - `RedisCookieJarStore`    — multi-instance, Tier 2+ (no loss on
 *     round-robin load balancers during an in-progress OAuth flow).
 *
 * Selection happens at boot via `getCookieJarStore()` based on whether
 * REDIS_URL is configured, mirroring the pattern used by `getCache()`
 * and `getPubSub()`.
 *
 * Shape: the value side is `string[]` (Set-Cookie lines). We store as
 * JSON for Redis to preserve ordering and per-cookie metadata; the
 * in-memory impl keeps the array directly.
 */

import { hasRedis } from "../../infra/index.ts";
import { getRedisConnection } from "../../lib/redis.ts";
import { logger } from "../../lib/logger.ts";

/**
 * Abstract cookie jar store. Keyed by `(sessionId, providerKey)` since
 * a single X-Session-Id can drive calls across multiple providers, each
 * of which has its own cookie scope.
 */
export interface CookieJarStore {
  /** Read cookies for a provider within a session. Returns [] when absent. */
  get(sessionId: string, providerKey: string): Promise<string[]>;
  /** Replace cookies for a provider within a session. Resets the TTL. */
  set(sessionId: string, providerKey: string, cookies: string[], ttlSeconds: number): Promise<void>;
  /** Release all resources (timers, connections). */
  shutdown(): Promise<void>;
}

/**
 * {@link CookieJarStore} backed by a `Map`. Opportunistically purges
 * expired entries when the map grows past a soft threshold — keeps the
 * memory footprint bounded without a background timer.
 */
export class InMemoryCookieJarStore implements CookieJarStore {
  private store = new Map<string, { cookies: string[]; expiresAt: number }>();
  private readonly softLimit: number;

  constructor(opts?: { softLimit?: number }) {
    this.softLimit = opts?.softLimit ?? 1024;
  }

  private cacheKey(sessionId: string, providerKey: string): string {
    return `${sessionId}::${providerKey}`;
  }

  async get(sessionId: string, providerKey: string): Promise<string[]> {
    const entry = this.store.get(this.cacheKey(sessionId, providerKey));
    if (!entry) return [];
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(this.cacheKey(sessionId, providerKey));
      return [];
    }
    return entry.cookies;
  }

  async set(
    sessionId: string,
    providerKey: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void> {
    const now = Date.now();
    this.store.set(this.cacheKey(sessionId, providerKey), {
      cookies,
      expiresAt: now + ttlSeconds * 1000,
    });
    if (this.store.size > this.softLimit) {
      for (const [key, entry] of this.store) {
        if (entry.expiresAt <= now) this.store.delete(key);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.store.clear();
  }

  /** @internal Exposed for test introspection. */
  _size(): number {
    return this.store.size;
  }
}

/**
 * Minimal Redis client shape the cookie jar depends on. Matches `ioredis`
 * for `get` and the `SET key value EX ttl` form — factored out so tests
 * can inject a fake without touching the shared connection singleton.
 */
export interface RedisCookieJarClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/**
 * {@link CookieJarStore} backed by Redis. Keys are scoped under
 * `cp:jar:` to keep the namespace clean. TTL is refreshed on every set
 * via PSETEX semantics (Redis `SET ... EX ...`).
 */
export class RedisCookieJarStore implements CookieJarStore {
  private readonly client: RedisCookieJarClient;

  constructor(client?: RedisCookieJarClient) {
    this.client = client ?? (getRedisConnection() as unknown as RedisCookieJarClient);
  }

  private cacheKey(sessionId: string, providerKey: string): string {
    return `cp:jar:${sessionId}:${providerKey}`;
  }

  async get(sessionId: string, providerKey: string): Promise<string[]> {
    try {
      const raw = await this.client.get(this.cacheKey(sessionId, providerKey));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch (err) {
      logger.warn("credential-proxy cookie jar GET failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async set(
    sessionId: string,
    providerKey: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.client.set(
        this.cacheKey(sessionId, providerKey),
        JSON.stringify(cookies),
        "EX",
        ttlSeconds,
      );
    } catch (err) {
      logger.warn("credential-proxy cookie jar SET failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async shutdown(): Promise<void> {
    // Redis connection lifecycle is owned by lib/redis.ts
  }
}

// ---------------------------------------------------------------------------
// Singleton factory — mirrors the `getCache()` / `getPubSub()` shape.
// ---------------------------------------------------------------------------

let jarStorePromise: Promise<CookieJarStore> | null = null;

export function getCookieJarStore(): Promise<CookieJarStore> {
  if (!jarStorePromise) {
    jarStorePromise = (async () => {
      if (hasRedis()) {
        return new RedisCookieJarStore();
      }
      return new InMemoryCookieJarStore();
    })();
  }
  return jarStorePromise;
}

/** @internal Test-only — reset the singleton so each test picks a fresh impl. */
export async function _resetCookieJarStoreForTesting(): Promise<void> {
  const existing = await jarStorePromise;
  await existing?.shutdown();
  jarStorePromise = null;
}
