// SPDX-License-Identifier: Apache-2.0

/**
 * TTL cache shared by the per-app resolvers (`smtp-config.ts`, `social-config.ts`).
 *
 * Both resolvers follow the same pattern: lookup by string key, cache the
 * resolved value (or `null` when no row exists) with a short TTL, invalidate
 * on admin mutation. The null TTL is shorter than the value TTL so that a
 * freshly-configured admin sees changes within ~30s without hammering the DB
 * on every login page render.
 */

const PER_APP_TTL_MS = 60_000;
const NULL_TTL_MS = 30_000;

interface Entry<V> {
  value: V | null;
  expiresAt: number;
}

export interface TtlCache<V> {
  get(key: string): V | null | undefined;
  set(key: string, value: V | null): void;
  delete(key: string): void;
  /** Test-only: clear all entries. Guarded by NODE_ENV check. */
  clearForTesting(): void;
}

export function createTtlCache<V>(): TtlCache<V> {
  const map = new Map<string, Entry<V>>();

  return {
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
    delete(key) {
      map.delete(key);
    },
    clearForTesting() {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("clearForTesting is test-only");
      }
      map.clear();
    },
  };
}
