// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the infra cookie jar stores.
 *
 * Redis impl is exercised via a fake {@link KeyValueCache} injected through
 * the `getCache` seam (dependency injection, per CLAUDE.md mocking policy —
 * no `mock.module`). The in-memory impl needs no infra.
 */

import { describe, it, expect } from "bun:test";
import { LocalCookieJarStore } from "../../src/infra/cookie-jar/local-cookie-jar.ts";
import { RedisCookieJarStore } from "../../src/infra/cookie-jar/redis-cookie-jar.ts";
import type { KeyValueCache, CacheSetOptions } from "../../src/infra/cache/interface.ts";

describe("LocalCookieJarStore", () => {
  it("returns [] for a missing entry", async () => {
    const jar = new LocalCookieJarStore();
    expect(await jar.get("s1", "gmail")).toEqual([]);
  });

  it("stores and returns cookies for the same (session, provider)", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "gmail", ["a=1", "b=2"], 60);
    expect(await jar.get("s1", "gmail")).toEqual(["a=1", "b=2"]);
  });

  it("isolates cookies across providers within the same session", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "gmail", ["gm=1"], 60);
    await jar.set("s1", "notion", ["nt=1"], 60);
    expect(await jar.get("s1", "gmail")).toEqual(["gm=1"]);
    expect(await jar.get("s1", "notion")).toEqual(["nt=1"]);
  });

  it("isolates cookies across sessions for the same provider", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "gmail", ["a=1"], 60);
    await jar.set("s2", "gmail", ["b=2"], 60);
    expect(await jar.get("s1", "gmail")).toEqual(["a=1"]);
    expect(await jar.get("s2", "gmail")).toEqual(["b=2"]);
  });

  it("overwrites cookies on subsequent set for the same key", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "gmail", ["old"], 60);
    await jar.set("s1", "gmail", ["new"], 60);
    expect(await jar.get("s1", "gmail")).toEqual(["new"]);
  });

  it("treats expired entries as missing and removes them", async () => {
    const jar = new LocalCookieJarStore();
    // 0-second TTL → expired immediately.
    await jar.set("s1", "gmail", ["x=1"], 0);
    // Nudge the clock.
    await new Promise((r) => setTimeout(r, 5));
    expect(await jar.get("s1", "gmail")).toEqual([]);
  });

  it("opportunistically purges expired entries past the soft limit", async () => {
    const jar = new LocalCookieJarStore({ softLimit: 2 });
    await jar.set("expired-1", "p", ["a"], 0);
    await jar.set("expired-2", "p", ["b"], 0);
    await new Promise((r) => setTimeout(r, 5));
    await jar.set("fresh", "p", ["c"], 60);
    expect(jar._size()).toBe(1);
    expect(await jar.get("fresh", "p")).toEqual(["c"]);
  });

  it("clears the store on shutdown", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "gmail", ["a"], 60);
    await jar.shutdown();
    expect(jar._size()).toBe(0);
  });
});

function createFakeCache(): KeyValueCache & {
  _store: Map<string, string>;
  _lastTtl: Map<string, number | undefined>;
} {
  const store = new Map<string, string>();
  const lastTtl = new Map<string, number | undefined>();
  return {
    _store: store,
    _lastTtl: lastTtl,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, opts?: CacheSetOptions) {
      store.set(key, value);
      lastTtl.set(key, opts?.ttlSeconds);
      return true;
    },
    async del(key) {
      store.delete(key);
    },
    async shutdown() {},
  };
}

/** Wrap a cache in the `getCache` seam the RedisCookieJarStore expects. */
function injectCache(cache: KeyValueCache): { getCache: () => Promise<KeyValueCache> } {
  return { getCache: async () => cache };
}

describe("RedisCookieJarStore", () => {
  it("writes cookies as JSON under the cp:jar: namespace with TTL", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("xyz", "gmail", ["a=1", "b=2"], 90);
    expect(fake._store.get("cp:jar:xyz:gmail")).toBe(JSON.stringify(["a=1", "b=2"]));
    expect(fake._lastTtl.get("cp:jar:xyz:gmail")).toBe(90);
  });

  it("reads JSON and returns string[]", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("s1", "gmail", ["only"], 60);
    expect(await jar.get("s1", "gmail")).toEqual(["only"]);
  });

  it("returns [] on missing keys", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    expect(await jar.get("unknown", "anywhere")).toEqual([]);
  });

  it("returns [] and logs on GET failure", async () => {
    const failing: KeyValueCache = {
      async get() {
        throw new Error("boom");
      },
      async set() {
        return true;
      },
      async del() {},
      async shutdown() {},
    };
    const jar = new RedisCookieJarStore(injectCache(failing));
    expect(await jar.get("s1", "gmail")).toEqual([]);
  });

  it("tolerates non-array JSON values", async () => {
    const fake = createFakeCache();
    fake._store.set("cp:jar:s1:gmail", JSON.stringify({ not: "array" }));
    const jar = new RedisCookieJarStore(injectCache(fake));
    expect(await jar.get("s1", "gmail")).toEqual([]);
  });

  it("swallows SET errors without throwing", async () => {
    const failing: KeyValueCache = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("unreachable redis");
      },
      async del() {},
      async shutdown() {},
    };
    const jar = new RedisCookieJarStore(injectCache(failing));
    // Should not throw — cookie persistence is best-effort.
    await jar.set("s1", "gmail", ["a"], 60);
  });

  it("scopes keys per (session, provider)", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("s1", "gmail", ["a"], 60);
    await jar.set("s1", "notion", ["b"], 60);
    await jar.set("s2", "gmail", ["c"], 60);
    expect(fake._store.size).toBe(3);
    expect(await jar.get("s1", "gmail")).toEqual(["a"]);
    expect(await jar.get("s1", "notion")).toEqual(["b"]);
    expect(await jar.get("s2", "gmail")).toEqual(["c"]);
  });
});
