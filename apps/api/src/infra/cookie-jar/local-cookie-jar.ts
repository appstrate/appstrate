// SPDX-License-Identifier: Apache-2.0

import type { CookieJarStore } from "./interface.ts";

/**
 * {@link CookieJarStore} backed by a `Map`. Opportunistically purges
 * expired entries when the map grows past a soft threshold — keeps the
 * memory footprint bounded without a background timer.
 */
export class LocalCookieJarStore implements CookieJarStore {
  private store = new Map<string, { cookies: string[]; expiresAt: number }>();
  private readonly softLimit: number;

  constructor(opts?: { softLimit?: number }) {
    this.softLimit = opts?.softLimit ?? 1024;
  }

  private cacheKey(sessionId: string, integrationKey: string): string {
    return `${sessionId}::${integrationKey}`;
  }

  async get(sessionId: string, integrationKey: string): Promise<string[]> {
    const entry = this.store.get(this.cacheKey(sessionId, integrationKey));
    if (!entry) return [];
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(this.cacheKey(sessionId, integrationKey));
      return [];
    }
    return entry.cookies;
  }

  async set(
    sessionId: string,
    integrationKey: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void> {
    const now = Date.now();
    this.store.set(this.cacheKey(sessionId, integrationKey), {
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
