// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import {
  createCache,
  configureCacheBus,
  receiveCacheInvalidation,
  setCacheClock,
  clearAllCachesLocally,
  listCaches,
  type CacheInvalidation,
} from "../src/cache.ts";

/**
 * The one cache primitive every platform cache builds on. Each test names the
 * property it pins; the negative control is stated where it is not obvious.
 */

let names = 0;
/** Registry names are process-unique, so every test mints its own. */
const uniqueName = (label: string) => `test-${label}-${++names}`;

afterEach(() => {
  setCacheClock(null);
  configureCacheBus(null);
});

describe("createCache — read-through", () => {
  it("loads once, then serves the value until the TTL", async () => {
    let clock = 1_000;
    setCacheClock(() => clock);
    const cache = createCache<string>({ name: uniqueName("ttl"), ttlMs: 100 });
    let loads = 0;
    const loader = async () => `v${++loads}`;

    expect(await cache.get("k", loader)).toBe("v1");
    clock += 99;
    expect(await cache.get("k", loader)).toBe("v1");
    expect(loads).toBe(1);

    // At the TTL the entry is gone: the loader runs again. Negative control —
    // a cache that never expires still answers `v1` with `loads === 1`.
    clock += 1;
    expect(await cache.get("k", loader)).toBe("v2");
    expect(loads).toBe(2);
  });

  it("coalesces concurrent loads of one key into a single loader call", async () => {
    const cache = createCache<number>({ name: uniqueName("coalesce"), ttlMs: 60_000 });
    let loads = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => (release = resolve));
    const loader = () => {
      loads += 1;
      return gate;
    };

    const results = Promise.all([
      cache.get("k", loader),
      cache.get("k", loader),
      cache.get("k", loader),
    ]);
    // All three are waiting on the same in-flight load.
    expect(loads).toBe(1);
    release(42);
    expect(await results).toEqual([42, 42, 42]);
    // Negative control: without coalescing this is 3.
    expect(loads).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 3, loads: 1 });
  });

  it("does not coalesce across keys", async () => {
    const cache = createCache<string>({ name: uniqueName("keys"), ttlMs: 60_000 });
    let loads = 0;
    const loader = async () => `v${++loads}`;
    await Promise.all([cache.get("a", loader), cache.get("b", loader)]);
    expect(loads).toBe(2);
  });

  it("does not store a value the `store` predicate rejects, and retries it next time", async () => {
    const cache = createCache<string | null>({ name: uniqueName("store"), ttlMs: 60_000 });
    let loads = 0;
    const loader = async () => (++loads === 1 ? null : "found");
    const store = (v: string | null) => v !== null;

    expect(await cache.get("k", loader, { store })).toBeNull();
    expect(cache.peek("k")).toBeUndefined();
    // The miss is not remembered: the second call loads again and finds it.
    expect(await cache.get("k", loader, { store })).toBe("found");
    expect(loads).toBe(2);
    // …and that one IS kept.
    expect(await cache.get("k", loader, { store })).toBe("found");
    expect(loads).toBe(2);
  });

  it("propagates a loader failure and caches nothing", async () => {
    const cache = createCache<string>({ name: uniqueName("fail"), ttlMs: 60_000 });
    await expect(cache.get("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(cache.peek("k")).toBeUndefined();
    // A later load is not poisoned by the failed in-flight slot.
    expect(await cache.get("k", async () => "ok")).toBe("ok");
  });

  it("evicts the oldest entry past `max`", async () => {
    const cache = createCache<number>({ name: uniqueName("max"), ttlMs: 60_000, max: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe(2);
    expect(cache.peek("c")).toBe(3);
    expect(cache.stats().size).toBe(2);
  });

  it("refuses a duplicate name and a non-positive TTL", () => {
    const name = uniqueName("dup");
    createCache({ name, ttlMs: 1 });
    expect(() => createCache({ name, ttlMs: 1 })).toThrow(/already registered/);
    expect(() => createCache({ name: uniqueName("ttl0"), ttlMs: 0 })).toThrow(/ttlMs/);
  });
});

describe("createCache — invalidation bus", () => {
  it("drops locally and publishes on invalidate() and clear()", () => {
    const published: CacheInvalidation[] = [];
    configureCacheBus({ publish: (m) => published.push(m) });
    const name = uniqueName("bus");
    const cache = createCache<number>({ name, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);

    cache.invalidate("a");
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBe(2);
    expect(published).toEqual([{ cache: name, key: "a", origin: expect.any(String) }]);

    cache.clear();
    expect(cache.peek("b")).toBeUndefined();
    expect(published[1]).toEqual({ cache: name, key: null, origin: expect.any(String) });
  });

  it("applies a delivered invalidation from another process, ignores its own echo", () => {
    const published: CacheInvalidation[] = [];
    configureCacheBus({ publish: (m) => published.push(m) });
    const name = uniqueName("recv");
    const cache = createCache<number>({ name, ttlMs: 60_000 });
    cache.set("a", 1);

    // Learn this process's origin id from a real broadcast.
    cache.invalidate("zzz");
    const ownOrigin = published[0]!.origin;

    // The echo of our own broadcast (pg NOTIFY delivers to the sender too)
    // must not touch entries a later load may have refreshed.
    receiveCacheInvalidation({ cache: name, key: "a", origin: ownOrigin });
    expect(cache.peek("a")).toBe(1);

    // Another replica's broadcast drops the entry. Negative control: without
    // routing by name / applying, `a` would still read 1.
    receiveCacheInvalidation({ cache: name, key: "a", origin: "another-replica" });
    expect(cache.peek("a")).toBeUndefined();

    // Whole-cache clear from another replica.
    cache.set("b", 2);
    receiveCacheInvalidation({ cache: name, key: null, origin: "another-replica" });
    expect(cache.peek("b")).toBeUndefined();

    // A name this process does not own is ignored, not an error.
    expect(() =>
      receiveCacheInvalidation({ cache: "no-such-cache", key: "a", origin: "another-replica" }),
    ).not.toThrow();
  });

  it("an invalidation during a load discards what that load would store", async () => {
    const cache = createCache<string>({ name: uniqueName("race"), ttlMs: 60_000 });
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const first = cache.get("k", () => gate);
    // The write that made the in-flight value stale lands now.
    cache.invalidate("k");
    release("stale");
    // The caller that started the load still gets its answer…
    expect(await first).toBe("stale");
    // …but the next reader loads fresh instead of reading the stale value.
    // (The slot was dropped; the completed load stored nothing under it.)
    let loads = 0;
    expect(await cache.get("k", async () => `fresh${++loads}`)).toBe("fresh1");
  });

  it("clearAllCachesLocally drops every registered cache without publishing", () => {
    const published: CacheInvalidation[] = [];
    configureCacheBus({ publish: (m) => published.push(m) });
    const a = createCache<number>({ name: uniqueName("all-a"), ttlMs: 60_000 });
    const b = createCache<number>({ name: uniqueName("all-b"), ttlMs: 60_000 });
    a.set("x", 1);
    b.set("y", 2);
    clearAllCachesLocally();
    expect(a.peek("x")).toBeUndefined();
    expect(b.peek("y")).toBeUndefined();
    expect(published).toEqual([]);
    expect(listCaches().map((s) => s.name)).toEqual(expect.arrayContaining([a.stats().name]));
  });
});
