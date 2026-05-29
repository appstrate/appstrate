// SPDX-License-Identifier: Apache-2.0

import type { CookieJarStore } from "./interface.ts";
import type { KeyValueCache } from "../cache/interface.ts";
import { getCache } from "../index.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * {@link CookieJarStore} backed by the shared {@link KeyValueCache} (Redis
 * in Tier 2+). Keys are scoped under `cp:jar:` to keep the namespace clean.
 * TTL is refreshed on every set.
 *
 * The cache is resolved lazily through the injectable `getCache` seam so the
 * unit tests can supply a fake cache without `mock.module` (per the codebase
 * mocking policy). Production defaults to the infra `getCache()` singleton.
 */
export class RedisCookieJarStore implements CookieJarStore {
  private readonly getCache: () => Promise<KeyValueCache>;

  constructor(deps?: { getCache?: () => Promise<KeyValueCache> }) {
    this.getCache = deps?.getCache ?? getCache;
  }

  private cacheKey(sessionId: string, integrationKey: string): string {
    return `cp:jar:${sessionId}:${integrationKey}`;
  }

  async get(sessionId: string, integrationKey: string): Promise<string[]> {
    try {
      const cache = await this.getCache();
      const raw = await cache.get(this.cacheKey(sessionId, integrationKey));
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch (err) {
      logger.warn("credential-proxy cookie jar GET failed", {
        error: getErrorMessage(err),
      });
      return [];
    }
  }

  async set(
    sessionId: string,
    integrationKey: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      await cache.set(this.cacheKey(sessionId, integrationKey), JSON.stringify(cookies), {
        ttlSeconds,
      });
    } catch (err) {
      logger.warn("credential-proxy cookie jar SET failed", {
        error: getErrorMessage(err),
      });
    }
  }

  async shutdown(): Promise<void> {
    // Redis connection lifecycle is owned by the shared cache singleton.
  }
}
