// SPDX-License-Identifier: Apache-2.0

/**
 * The platform transport for `@appstrate/core/cache` invalidations: one
 * Postgres NOTIFY channel, `cache_invalidate`.
 *
 * Why NOTIFY and not Redis: every tier already has it. PGlite (tier 0) and
 * Postgres (tier 1+) both LISTEN through `listenClient`, the same channel
 * family the realtime fan-out rides (`services/realtime.ts`), so a cache
 * dropped on the replica that took a write is dropped on every replica within
 * a round trip — without making Redis a requirement of cache coherence. A
 * broadcast that is lost (process exit mid-notify, a replica whose LISTEN is
 * down) degrades to the cache's TTL, which is what every cache did before the
 * bus existed. No data depends on delivery.
 *
 * The payload is the invalidation itself: a cache name, a key or `null`, and
 * the publishing process's id. Keys are identifiers (org ids, model ids,
 * client ids) — never a value, so nothing a cache holds ever crosses the
 * channel.
 *
 * `initCacheBus` is idempotent and boot-only (`lib/boot.ts`, next to
 * `initRealtime`). Until it runs, invalidations are process-local.
 */

import { sql } from "drizzle-orm";
import { db, listenClient } from "@appstrate/db/client";
import {
  configureCacheBus,
  receiveCacheInvalidation,
  type CacheInvalidation,
} from "@appstrate/core/cache";
import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export const CACHE_INVALIDATE_CHANNEL = "cache_invalidate";

let initialized = false;

function parseInvalidation(payload: string): CacheInvalidation | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { cache, key, origin } = raw as Record<string, unknown>;
  if (typeof cache !== "string" || typeof origin !== "string") return null;
  if (key !== null && typeof key !== "string") return null;
  return { cache, key, origin };
}

/** Fire-and-forget NOTIFY — a failure is logged and the caches fall back to their TTL. */
function publish(message: CacheInvalidation): void {
  const payload = JSON.stringify(message);
  void db.execute(sql`SELECT pg_notify(${CACHE_INVALIDATE_CHANNEL}, ${payload})`).catch((err) => {
    logger.warn("cache invalidation notify failed — replicas fall back to the TTL", {
      cache: message.cache,
      key: message.key,
      error: getErrorMessage(err),
    });
  });
}

/**
 * LISTEN on the channel and install the publisher. Safe to call more than
 * once — only the first call does anything.
 */
export async function initCacheBus(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listenClient.listen(CACHE_INVALIDATE_CHANNEL, (payload) => {
    const message = parseInvalidation(payload);
    if (!message) {
      logger.warn("cache invalidation frame ignored — malformed payload", {
        preview: payload.slice(0, 200),
      });
      return;
    }
    receiveCacheInvalidation(message);
  });
  configureCacheBus({ publish });
  logger.info("Cache invalidation bus initialized", { channel: CACHE_INVALIDATE_CHANNEL });
}
