// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for {@link withRedisLock}'s lease watchdog.
 *
 * The lock used to be a plain `SET … EX ttl NX` with no renewal: a critical
 * section slower than the TTL (an OAuth exchange plus a DB read under
 * pressure) silently lost the lock to a waiter, and the two then spent the
 * same rotating `refresh_token` — exactly the double-spend the lock exists to
 * prevent.
 *
 * These need a real Redis (the Lua compare-and-PEXPIRE and key expiry are the
 * behaviour under test), so they skip on tier 0.
 */

import { it, expect, beforeAll, afterAll } from "bun:test";
import Redis from "ioredis";
import { describeRequiresRedis } from "../helpers/tier.ts";
import { withRedisLock } from "../../src/lib/distributed-lock.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeRequiresRedis("withRedisLock lease watchdog", () => {
  let redis: Redis;
  const keys: string[] = [];

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 3 });
  });

  function uniqueKey(name: string): string {
    const key = `test-lock:${name}:${Date.now()}`;
    keys.push(key);
    return key;
  }

  afterAll(async () => {
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it("renews the lease so a critical section outliving the TTL keeps the lock", async () => {
    const key = uniqueKey("renewed");
    const opts = { ttlSeconds: 1, maxHoldSeconds: 10, label: "test-renewed" };
    const events: string[] = [];

    const holder = withRedisLock(key, opts, async () => {
      events.push("holder:enter");
      // 2.5x the TTL: without renewal the lease lapses mid-section.
      await sleep(2_500);
      events.push("holder:exit");
    });

    // Let the holder acquire before the waiter starts polling.
    await sleep(100);
    const waiter = withRedisLock(key, opts, async () => {
      events.push("waiter:enter");
    });

    await Promise.all([holder, waiter]);

    expect(events).toEqual(["holder:enter", "holder:exit", "waiter:enter"]);
  }, 15_000);

  it("stops renewing past maxHoldSeconds so a wedged holder cannot own the key forever", async () => {
    const key = uniqueKey("capped");
    let existsAfterCap = -1;

    await withRedisLock(
      key,
      { ttlSeconds: 1, maxHoldSeconds: 1, label: "test-capped" },
      async () => {
        // Renewals stop at ~1s and the last lease expires ~1s later.
        await sleep(2_600);
        existsAfterCap = await redis.exists(key);
        await sleep(200);
      },
    );

    expect(existsAfterCap).toBe(0);
  }, 15_000);
});
