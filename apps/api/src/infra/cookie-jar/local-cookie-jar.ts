// SPDX-License-Identifier: Apache-2.0

import type { CookieJar } from "@appstrate/afps-runtime/resolvers";
import type { CookieJarStore } from "./interface.ts";

/** Deep copy — a caller mutating a jar it read or wrote must not alter the store. */
function cloneJar(jar: CookieJar): CookieJar {
  return new Map([...jar].map(([key, cookies]) => [key, [...cookies]]));
}

/**
 * {@link CookieJarStore} backed by a `Map`. Opportunistically purges
 * expired entries when the map grows past a soft threshold — keeps the
 * memory footprint bounded without a background timer.
 */
export class LocalCookieJarStore implements CookieJarStore {
  private store = new Map<string, { jar: CookieJar; expiresAt: number }>();
  private readonly softLimit: number;

  constructor(opts?: { softLimit?: number }) {
    this.softLimit = opts?.softLimit ?? 1024;
  }

  private cacheKey(sessionId: string, integrationKey: string): string {
    return `${sessionId}::${integrationKey}`;
  }

  async get(sessionId: string, integrationKey: string): Promise<CookieJar> {
    const entry = this.store.get(this.cacheKey(sessionId, integrationKey));
    if (!entry) return new Map();
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(this.cacheKey(sessionId, integrationKey));
      return new Map();
    }
    return cloneJar(entry.jar);
  }

  async set(
    sessionId: string,
    integrationKey: string,
    jar: CookieJar,
    ttlSeconds: number,
  ): Promise<void> {
    const now = Date.now();
    this.store.set(this.cacheKey(sessionId, integrationKey), {
      jar: cloneJar(jar),
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
