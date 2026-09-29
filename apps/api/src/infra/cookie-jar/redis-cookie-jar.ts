// SPDX-License-Identifier: Apache-2.0

import type { CookieJar } from "@appstrate/afps-runtime/resolvers";
import type { CookieJarStore } from "./interface.ts";
import type { KeyValueCache } from "../cache/interface.ts";
import { getCache } from "../index.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * {@link CookieJarStore} backed by the shared {@link KeyValueCache} (Redis
 * in Tier 2+). Keys are scoped under `cp:cookies:`; the jar is stored as the
 * JSON array of its entries. TTL is refreshed on every set.
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

  private cacheKey(sessionId: string, connectionId: string): string {
    return `cp:cookies:${sessionId}:${connectionId}`;
  }

  async get(sessionId: string, connectionId: string): Promise<CookieJar> {
    try {
      const cache = await this.getCache();
      const raw = await cache.get(this.cacheKey(sessionId, connectionId));
      return raw ? new Map(JSON.parse(raw)) : new Map();
    } catch (err) {
      logger.warn("credential-proxy cookie jar GET failed", {
        error: getErrorMessage(err),
      });
      return new Map();
    }
  }

  async set(
    sessionId: string,
    connectionId: string,
    jar: CookieJar,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      await cache.set(this.cacheKey(sessionId, connectionId), JSON.stringify([...jar]), {
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
