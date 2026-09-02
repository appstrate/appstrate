// SPDX-License-Identifier: Apache-2.0

/**
 * The cache invalidation bus over Postgres NOTIFY (`lib/cache-bus.ts`).
 *
 * A cache dropped on the replica that took a write must be dropped on every
 * replica. This test plays the other replica: it publishes on the channel
 * with a foreign `origin` and asserts the local cache lost the entry; then it
 * publishes with this process's own origin and asserts the entry survived
 * (the echo of one's own broadcast must not undo a value a later load
 * refreshed). Real LISTEN/NOTIFY on the test tier (PGlite or Postgres), no
 * mocks.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { configureCacheBus, createCache, type CacheInvalidation } from "@appstrate/core/cache";
import { CACHE_INVALIDATE_CHANNEL, initCacheBus } from "../../../src/lib/cache-bus.ts";

const cache = createCache<number>({ name: "test-cache-bus", ttlMs: 60_000 });

/** What another replica's `invalidate()` puts on the wire. */
async function notifyFrom(message: CacheInvalidation): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${CACHE_INVALIDATE_CHANNEL}, ${JSON.stringify(message)})`);
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

/** This process's origin, learned from a broadcast the bus itself publishes. */
let ownOrigin = "";

describe("cache invalidation bus (NOTIFY)", () => {
  beforeAll(async () => {
    await initCacheBus();
  });

  afterEach(() => {
    cache.clear();
  });

  // Later suites in this process must not NOTIFY on every invalidate.
  afterAll(() => configureCacheBus(null));

  it("drops the local entry when another replica invalidates it", async () => {
    cache.set("k", 1);
    await notifyFrom({ cache: "test-cache-bus", key: "k", origin: "replica-b" });
    // Negative control: with no LISTEN wired, this stays 1 until the TTL.
    expect(await until(() => cache.peek("k") === undefined)).toBe(true);
  });

  it("drops every entry when another replica clears the cache", async () => {
    cache.set("a", 1);
    cache.set("b", 2);
    await notifyFrom({ cache: "test-cache-bus", key: null, origin: "replica-b" });
    expect(await until(() => cache.stats().size === 0)).toBe(true);
  });

  it("publishes its own invalidations on the channel, and ignores their echo", async () => {
    // Capture the wire frame through a second listener on the same channel —
    // the shape another replica would receive.
    const { listenClient } = await import("@appstrate/db/client");
    const frames: CacheInvalidation[] = [];
    await listenClient.listen(CACHE_INVALIDATE_CHANNEL, (payload) => {
      // This listener outlives the test; the malformed-frame case below
      // deliberately puts non-JSON on the channel.
      try {
        frames.push(JSON.parse(payload) as CacheInvalidation);
      } catch {
        // not one of ours
      }
    });

    cache.set("k", 1);
    cache.invalidate("k");
    expect(
      await until(() => frames.some((f) => f.cache === "test-cache-bus" && f.key === "k")),
    ).toBe(true);
    ownOrigin = frames.find((f) => f.cache === "test-cache-bus")!.origin;
    expect(ownOrigin.length).toBeGreaterThan(0);

    // A value loaded AFTER our own invalidate must survive the echo of that
    // invalidate arriving from Postgres.
    cache.set("k", 2);
    await notifyFrom({ cache: "test-cache-bus", key: "k", origin: ownOrigin });
    // Give the echo time to land (a foreign origin lands well within this).
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.peek("k")).toBe(2);
  });

  it("ignores a malformed frame and a cache it does not own", async () => {
    cache.set("k", 1);
    await db.execute(sql`SELECT pg_notify(${CACHE_INVALIDATE_CHANNEL}, ${"not json"})`);
    await notifyFrom({ cache: "someone-elses-cache", key: "k", origin: "replica-b" });
    await new Promise((r) => setTimeout(r, 200));
    expect(cache.peek("k")).toBe(1);
  });
});
