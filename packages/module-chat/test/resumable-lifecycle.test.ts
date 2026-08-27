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
 * No live Redis: a dead port is exactly the condition the retry budget exists
 * for, and the in-memory tier is what proves the env is no longer consulted.
 */

import { describe, it, expect, afterAll } from "bun:test";
import chatModule from "../src/index.ts";
import {
  closeResumableStore,
  configureResumableStore,
  createResumableRedis,
  getResumableContext,
} from "../src/resumable.ts";

/** Nothing listens here — connecting is refused immediately. */
const DEAD_REDIS = "redis://127.0.0.1:1";

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

  it("shutdown() closes the store — the next boot builds a fresh one", async () => {
    configureResumableStore(null);
    await closeResumableStore();
    const before = getResumableContext();
    // Control: the context is a singleton for as long as the module is up.
    expect(getResumableContext()).toBe(before);

    await chatModule.shutdown?.();

    expect(getResumableContext()).not.toBe(before);
  });
});
