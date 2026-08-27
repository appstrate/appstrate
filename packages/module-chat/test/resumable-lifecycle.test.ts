// SPDX-License-Identifier: Apache-2.0

/**
 * The resumable store's Redis connection is a REQUEST-PATH resource, and the
 * module owns its whole lifetime.
 *
 * Three properties, each of which was false:
 *   - the store's tier comes from what the platform hands the module at init
 *     (`ctx.redisUrl`), not from a second, independent read of `process.env`;
 *   - its client fails commands on a finite retry budget, like every other
 *     request-path client (`apps/api/src/lib/redis.ts`) — `GET
 *     /api/chat/sessions/:id/stream` reads through it, and "retry forever"
 *     turns a Redis outage into a hung request instead of an error;
 *   - `chatModule.shutdown()` closes it. It used to only drain in-flight turns,
 *     so the connection (and its reconnect loop) outlived the module.
 *
 * No live Redis anywhere below: a dead port is exactly the condition the retry
 * budget exists for, and the in-memory tier is what proves the env is no longer
 * consulted. The client this module opens is obtained through the injected
 * factory (`configureResumableStore`'s second argument), which is what makes
 * "shutdown closed it" observable rather than inferred.
 */

import { describe, it, expect, afterAll } from "bun:test";
import type Redis from "ioredis";
import chatModule from "../src/index.ts";
import { drainTurns } from "../src/inflight.ts";
import {
  closeResumableStore,
  configureResumableStore,
  createResumableRedis,
  getResumableContext,
} from "../src/resumable.ts";

/** Nothing listens here — connecting is refused immediately. */
const DEAD_REDIS = "redis://127.0.0.1:1";

/** Bound on "the client should have closed by now". Generous; it takes ~1ms. */
const CLOSE_DEADLINE_MS = 2_000;

// The context is a process-wide singleton shared with every other suite in this
// run: leave it on the tier the harness expects (tier 0 → in-memory).
afterAll(async () => {
  configureResumableStore(null);
  await closeResumableStore();
});

describe("resumable store lifecycle", () => {
  it("ignores process.env.REDIS_URL — the tier comes from the init context", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = DEAD_REDIS;
    try {
      configureResumableStore(null);
      await closeResumableStore(); // drop any context an earlier suite built
      // In-memory: an unknown id resolves to null at once. Were the env still
      // read, this would be a command against an unreachable Redis.
      expect(await getResumableContext().resume(crypto.randomUUID())).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
      await closeResumableStore();
    }
  });

  it("fails a command against an unreachable Redis instead of hanging", async () => {
    const client = createResumableRedis(DEAD_REDIS);
    try {
      // With `maxRetriesPerRequest: null` this promise NEVER settles and the
      // request reading through it hangs with it.
      await expect(client.get("chat:resumable:probe")).rejects.toThrow();
    } finally {
      client.disconnect();
    }
  });

  it("closeResumableStore() actually ENDS the client it opened", async () => {
    // The client is captured through the injected factory, so this asserts the
    // connection closed — not merely that the context singleton was replaced,
    // which is all the previous version of this test could see and which would
    // have stayed green with the `quit()` call deleted.
    const opened: Redis[] = [];
    const ended: Array<Promise<"ended">> = [];
    configureResumableStore(DEAD_REDIS, (url) => {
      const redis = createResumableRedis(url);
      opened.push(redis);
      ended.push(new Promise<"ended">((resolve) => redis.once("end", () => resolve("ended"))));
      return redis;
    });

    try {
      const before = getResumableContext();
      expect(opened).toHaveLength(1);
      // Control: the store is built once and the client is live until close.
      expect(getResumableContext()).toBe(before);
      expect(opened[0]!.status).not.toBe("end");

      await closeResumableStore();

      // `quit()` resolves before ioredis flips the socket, so wait for the
      // observable close. Raced against a deadline so a client that never
      // closes fails as an assertion, not as a suite-wide timeout.
      const outcome = await Promise.race([
        ended[0]!,
        Bun.sleep(CLOSE_DEADLINE_MS).then(() => "still open" as const),
      ]);
      expect(outcome).toBe("ended");

      // …and the singleton is gone, so the next boot builds a fresh store.
      configureResumableStore(null);
      expect(getResumableContext()).not.toBe(before);
    } finally {
      configureResumableStore(null);
      await closeResumableStore();
      for (const redis of opened) redis.disconnect();
    }
  });

  it("shutdown() closes the store — the next boot builds a fresh one", async () => {
    configureResumableStore(null);
    await closeResumableStore();
    const before = getResumableContext();
    // Control: the context is a singleton for as long as the module is up.
    expect(getResumableContext()).toBe(before);

    // `chatModule.shutdown()` drains in-flight turns BEFORE closing the store,
    // on a 25s budget, and `inflight.ts`'s registry is a process-wide singleton
    // shared with every other suite in this `bun test` run — module state IS
    // shared across test files. A turn left pending by another suite therefore
    // makes this drain outlive the 5s per-test timeout: the test passed when
    // run alone and timed out at 5000ms in CI, where the whole suite runs in
    // one process. Asserting the registry is quiescent turns that into a named
    // failure pointing at the leaking suite instead of an unexplained hang.
    // (`drainTurns(0)` reports the count without waiting on it.)
    expect(await drainTurns(0)).toBe(0);

    await chatModule.shutdown?.();

    expect(getResumableContext()).not.toBe(before);
  });
});
