// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the infra cookie jar stores.
 *
 * Redis impl is exercised via a fake {@link KeyValueCache} injected through
 * the `getCache` seam (dependency injection, per AGENTS.md mocking policy —
 * no `mock.module`). The in-memory impl needs no infra.
 */

import { describe, it, expect } from "bun:test";
import { LocalCookieJarStore } from "../../src/infra/cookie-jar/local-cookie-jar.ts";
import { RedisCookieJarStore } from "../../src/infra/cookie-jar/redis-cookie-jar.ts";
import type { KeyValueCache, CacheSetOptions } from "../../src/infra/cache/interface.ts";
import type { CookieJar } from "@appstrate/afps-runtime/resolvers";
import { decrypt, encrypt } from "@appstrate/connect";

/** Two buckets — their keys are opaque to the store; `expiresAt` must survive the round trip. */
const JAR: CookieJar = new Map([
  ["@s/shop https://a.example", [{ pair: "a=1" }, { pair: "b=2", expiresAt: 1_900_000_000_000 }]],
  ["@s/shop https://b.example", [{ pair: "c=3" }]],
]);

const jarOf = (pair: string): CookieJar => new Map([["bucket", [{ pair }]]]);

describe("LocalCookieJarStore", () => {
  it("returns an empty jar for a missing entry", async () => {
    const jar = new LocalCookieJarStore();
    expect(await jar.get("s1", "conn-a")).toEqual(new Map());
  });

  it("round-trips a multi-bucket jar for the same (session, connection)", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "conn-a", JAR, 60);
    expect(await jar.get("s1", "conn-a")).toEqual(JAR);
  });

  it("isolates jars across connections within the same session", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "conn-a", jarOf("gm=1"), 60);
    await jar.set("s1", "conn-b", jarOf("nt=1"), 60);
    expect(await jar.get("s1", "conn-a")).toEqual(jarOf("gm=1"));
    expect(await jar.get("s1", "conn-b")).toEqual(jarOf("nt=1"));
  });

  it("isolates jars across sessions for the same connection", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "conn-a", jarOf("a=1"), 60);
    await jar.set("s2", "conn-a", jarOf("b=2"), 60);
    expect(await jar.get("s1", "conn-a")).toEqual(jarOf("a=1"));
    expect(await jar.get("s2", "conn-a")).toEqual(jarOf("b=2"));
  });

  it("overwrites the jar on subsequent set for the same key", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "conn-a", jarOf("old=1"), 60);
    await jar.set("s1", "conn-a", jarOf("new=1"), 60);
    expect(await jar.get("s1", "conn-a")).toEqual(jarOf("new=1"));
  });

  it("treats expired entries as missing and removes them", async () => {
    const jar = new LocalCookieJarStore();
    // 0-second TTL → expired immediately.
    await jar.set("s1", "conn-a", jarOf("x=1"), 0);
    // Nudge the clock.
    await new Promise((r) => setTimeout(r, 5));
    expect(await jar.get("s1", "conn-a")).toEqual(new Map());
    expect(jar._size()).toBe(0);
  });

  it("opportunistically purges expired entries past the soft limit", async () => {
    const jar = new LocalCookieJarStore({ softLimit: 2 });
    await jar.set("expired-1", "p", jarOf("a=1"), 0);
    await jar.set("expired-2", "p", jarOf("b=1"), 0);
    await new Promise((r) => setTimeout(r, 5));
    await jar.set("fresh", "p", jarOf("c=1"), 60);
    expect(jar._size()).toBe(1);
    expect(await jar.get("fresh", "p")).toEqual(jarOf("c=1"));
  });

  it("clears the store on shutdown", async () => {
    const jar = new LocalCookieJarStore();
    await jar.set("s1", "conn-a", jarOf("a=1"), 60);
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
  it("writes the jar entries encrypted under the cp:cookies: namespace with TTL", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("xyz", "conn-a", JAR, 90);
    const stored = fake._store.get("cp:cookies:xyz:conn-a")!;
    expect(stored).not.toContain("a=1");
    expect(decrypt(stored)).toBe(JSON.stringify([...JAR]));
    expect(fake._lastTtl.get("cp:cookies:xyz:conn-a")).toBe(90);
  });

  it("round-trips a multi-bucket jar", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("s1", "conn-a", JAR, 60);
    expect(await jar.get("s1", "conn-a")).toEqual(JAR);
  });

  it("returns an empty jar on missing keys", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    expect(await jar.get("unknown", "anywhere")).toEqual(new Map());
  });

  it("returns an empty jar and logs on GET failure", async () => {
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
    expect(await jar.get("s1", "conn-a")).toEqual(new Map());
  });

  it.each([
    ["a plaintext entry", JSON.stringify([...JAR])],
    ["non-array JSON", encrypt(JSON.stringify({ not: "array" }))],
    ["invalid JSON", encrypt("{not json")],
  ])("reads %s as an empty jar", async (_label, raw) => {
    const fake = createFakeCache();
    fake._store.set("cp:cookies:s1:conn-a", raw);
    const jar = new RedisCookieJarStore(injectCache(fake));
    expect(await jar.get("s1", "conn-a")).toEqual(new Map());
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
    await jar.set("s1", "conn-a", jarOf("a=1"), 60);
  });

  it("scopes keys per (session, connection)", async () => {
    const fake = createFakeCache();
    const jar = new RedisCookieJarStore(injectCache(fake));
    await jar.set("s1", "conn-a", jarOf("a=1"), 60);
    await jar.set("s1", "conn-b", jarOf("b=1"), 60);
    await jar.set("s2", "conn-a", jarOf("c=1"), 60);
    expect(fake._store.size).toBe(3);
    expect(await jar.get("s1", "conn-a")).toEqual(jarOf("a=1"));
    expect(await jar.get("s1", "conn-b")).toEqual(jarOf("b=1"));
    expect(await jar.get("s2", "conn-a")).toEqual(jarOf("c=1"));
  });
});
