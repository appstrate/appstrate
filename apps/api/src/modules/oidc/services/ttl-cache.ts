// SPDX-License-Identifier: Apache-2.0

/**
 * TTL cache + in-flight dedup shared by the per-app resolvers
 * (`smtp-config.ts`, `social-config.ts`).
 *
 * Features:
 *  - Lookup by string key with short TTL (null entries cached with shorter TTL).
 *  - In-flight promise dedup so concurrent cache misses for the same key
 *    share a single DB round-trip.
 *  - Cross-instance invalidation via the platform Pub/Sub (Redis when
 *    `REDIS_URL` is set, in-memory EventEmitter otherwise). Each cache
 *    instance declares a channel name at construction; `delete()` publishes
 *    the invalidated key to that channel, and every subscriber (including
 *    the publisher itself) evicts locally. The null TTL (30s) bounds the
 *    worst-case staleness window when pub/sub is unavailable.
 */

import { getPubSub } from "../../../infra/index.ts";
import { logger } from "../../../lib/logger.ts";

const PER_APP_TTL_MS = 60_000;
const NULL_TTL_MS = 30_000;

interface Entry<V> {
  value: V | null;
  expiresAt: number;
}

export interface TtlCache<V> {
  get(key: string): V | null | undefined;
  set(key: string, value: V | null): void;
  delete(key: string): Promise<void>;
  /**
   * Run `loader` while deduping concurrent calls for the same key. If another
   * caller is already resolving the same key, the in-flight promise is
   * returned. Result is cached with the usual TTL rules.
   */
  getOrLoad(key: string, loader: () => Promise<V | null>): Promise<V | null>;
  /** Test-only: clear all entries. Guarded by NODE_ENV check. */
  clearForTesting(): void;
}

export function createTtlCache<V>(channel: string): TtlCache<V> {
  const map = new Map<string, Entry<V>>();
  const inflight = new Map<string, Promise<V | null>>();

  // Subscribe once at construction. Any publish (local or from another
  // instance) invalidates the matching key.
  void (async () => {
    try {
      const pubsub = await getPubSub();
      await pubsub.subscribe(channel, (message) => {
        if (!message) return;
        map.delete(message);
      });
    } catch (err) {
      logger.warn("oidc per-app cache: pub/sub subscribe failed, running single-instance", {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  const cache: TtlCache<V> = {
    get(key) {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      const ttl = value === null ? NULL_TTL_MS : PER_APP_TTL_MS;
      map.set(key, { value, expiresAt: Date.now() + ttl });
    },
    async delete(key) {
      map.delete(key);
      try {
        const pubsub = await getPubSub();
        await pubsub.publish(channel, key);
      } catch (err) {
        logger.warn("oidc per-app cache: pub/sub publish failed", {
          channel,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async getOrLoad(key, loader) {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const existing = inflight.get(key);
      if (existing) return existing;
      const promise = (async () => {
        try {
          const value = await loader();
          cache.set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },
    clearForTesting() {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("clearForTesting is test-only");
      }
      map.clear();
      inflight.clear();
    },
  };

  return cache;
}
