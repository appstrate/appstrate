// SPDX-License-Identifier: Apache-2.0

import type { KeyValueCache, CacheSetOptions } from "./interface.ts";

interface CacheEntry {
  value: string;
  expiresAt: number | null; // epoch ms, null = no expiry
}

/**
 * In-memory key-value cache with TTL support.
 * Purges expired entries every 60 seconds.
 */
export class LocalCache implements KeyValueCache {
  private store = new Map<string, CacheEntry>();
  private purgeInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.purgeInterval = setInterval(() => this.purge(), 60_000);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, opts?: CacheSetOptions): Promise<boolean> {
    if (opts?.nx) {
      const existing = await this.get(key);
      if (existing !== null) return false;
    }

    const expiresAt = opts?.ttlSeconds ? Date.now() + opts.ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return true;
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.purgeInterval);
    this.store.clear();
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
