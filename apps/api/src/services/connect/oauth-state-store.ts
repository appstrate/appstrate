// SPDX-License-Identifier: Apache-2.0

import type { OAuthStateStore, OAuthStateRecord } from "@appstrate/connect";
import { getCache } from "../../infra/index.ts";

const KEY_PREFIX = "oauth-state:";

/**
 * OAuth state store backed by the platform KV cache (Redis when available,
 * in-memory fallback otherwise). Entries auto-expire via TTL — no cleanup job.
 */
export const oauthStateStore: OAuthStateStore = {
  async set(key: string, record: OAuthStateRecord, ttlSeconds: number): Promise<void> {
    const cache = await getCache();
    await cache.set(KEY_PREFIX + key, JSON.stringify(record), { ttlSeconds });
  },
  async get(key: string): Promise<OAuthStateRecord | null> {
    const cache = await getCache();
    const raw = await cache.get(KEY_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as OAuthStateRecord;
  },
  async delete(key: string): Promise<void> {
    const cache = await getCache();
    await cache.del(KEY_PREFIX + key);
  },
};
