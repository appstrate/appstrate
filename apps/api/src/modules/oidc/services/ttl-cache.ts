// SPDX-License-Identifier: Apache-2.0

/**
 * TTL cache with cross-instance invalidation — shared by the per-app
 * resolvers (`smtp.ts`, `social.ts`).
 *
 * Features:
 *  - Lookup by string key with short TTL (null entries cached with shorter TTL).
 *  - Cross-instance invalidation via the platform Pub/Sub (Redis when
 *    `REDIS_URL` is set, in-memory EventEmitter otherwise). Each cache
 *    instance declares a channel at construction; `delete()` publishes the
 *    invalidated key, every subscriber (including the publisher) evicts
 *    locally. The null TTL bounds the worst-case staleness window when
 *    pub/sub is unavailable.
 *
 * Deliberately *not* included: in-flight promise dedup. Per-app SMTP/social
 * config is admin-reconfigured rarely; the occasional duplicate DB round-trip
 * on a cold-cache burst is not worth the extra state machine.
 */

import { getPubSub } from "../../../infra/index.ts";
import { logger } from "../../../lib/logger.ts";

const PER_APP_TTL_MS = 60_000;
const NULL_TTL_MS = 10_000;

interface Entry<V> {
  value: V | null;
  expiresAt: number;
}

export interface TtlCache<V> {
  get(key: string): V | null | undefined;
  set(key: string, value: V | null): void;
  delete(key: string): Promise<void>;
  getOrLoad(key: string, loader: () => Promise<V | null>): Promise<V | null>;
  /** Test-only: clear all entries. Guarded by NODE_ENV check. */
  clearForTesting(): void;
}

export function createTtlCache<V>(channel: string): TtlCache<V> {
  const map = new Map<string, Entry<V>>();

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
      const value = await loader();
      cache.set(key, value);
      return value;
    },
    clearForTesting() {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("clearForTesting is test-only");
      }
      map.clear();
    },
  };

  return cache;
}
