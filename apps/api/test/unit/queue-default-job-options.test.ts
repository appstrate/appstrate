// SPDX-License-Identifier: Apache-2.0

/**
 * `createQueue`'s `defaultJobOptions` must reach the LOCAL implementation too.
 *
 * Every other LocalQueue retry test passes `attempts` explicitly to `add()`,
 * which is exactly why they stayed green while the queue-level defaults were
 * dropped on the floor: `createQueue` forwarded them to `BullMQQueue` and
 * constructed `new LocalQueue(name)`. The jobs that actually run in production
 * are enqueued BARE — `webhooks/service.ts` calls `add("deliver", {...})` with
 * no options at all — so on any Redis-less deployment (Tier 0/1, the documented
 * self-hosting default) a delivery that hit a transient 503 was attempted once
 * and dropped, on a queue configured for 8 attempts with custom backoff.
 *
 * These tests therefore call `add()` with NO per-job options. That is the whole
 * point; adding them back would restore the blind spot.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { createQueue } from "../../src/infra/queue/index.ts";
import type { JobQueue } from "../../src/infra/queue/interface.ts";

/** Poll `predicate` every 5ms until it holds (or fail after `timeoutMs`). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createQueue — queue-level defaultJobOptions (no Redis)", () => {
  let previousRedisUrl: string | undefined;
  let queue: JobQueue<{ v: string }> | null = null;

  beforeEach(() => {
    // Force the Redis-less branch of `createQueue` regardless of the developer's
    // local .env — this is the deployment tier the defect only ever affected.
    previousRedisUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    _resetCacheForTesting();
  });

  afterEach(async () => {
    // `0` tears down immediately: a production grace budget would sit here
    // draining the retry timers this file deliberately created.
    await queue?.shutdown(0);
    queue = null;
    if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousRedisUrl;
    _resetCacheForTesting();
  });

  it("retries a BARE-enqueued job up to the queue-level `attempts`", async () => {
    const q = await createQueue<{ v: string }>("default-opts-retry", {
      attempts: 3,
      backoff: { type: "custom" },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
    queue = q;

    let attempts = 0;
    q.process(
      async () => {
        attempts++;
        throw new Error("transient 503");
      },
      // 1ms backoff: this asserts the ATTEMPT COUNT, not the wall clock.
      { backoffStrategy: () => 1 },
    );

    // No per-job options — the webhook-delivery call shape.
    await q.add("deliver", { v: "x" });

    await waitFor(() => attempts >= 3);
    // Drained (a sleeping retry still counts as active), so 3 is final, not
    // a snapshot taken mid-chain.
    await waitFor(async () => (await q.count()) === 0);
    expect(attempts).toBe(3);
  });

  it("lets per-job options override the queue-level default", async () => {
    // The merge direction: per-job ON TOP of the defaults, as BullMQ does it.
    const q = await createQueue<{ v: string }>("default-opts-override", {
      attempts: 5,
      backoff: { type: "custom" },
    });
    queue = q;

    let attempts = 0;
    q.process(
      async () => {
        attempts++;
        throw new Error("transient");
      },
      { backoffStrategy: () => 1 },
    );

    await q.add("deliver", { v: "x" }, { attempts: 1 });

    await waitFor(() => attempts >= 1);
    await waitFor(async () => (await q.count()) === 0);
    expect(attempts).toBe(1);
  });

  /**
   * `attempts` is the only key of `defaultJobOptions` this queue reads. The
   * retry DELAY comes from `WorkerOptions.backoffStrategy` (passed to
   * `process()`), never from `backoff` — which exists on the option type only
   * because BullMQ uses `{ type: "custom" }` as a pointer to the worker-side
   * strategy. These two pin that split, which the constructor's doc comment
   * used to state backwards ("only `attempts` and `backoff` mean anything").
   */
  it("takes the retry delay from the worker's backoffStrategy", async () => {
    const q = await createQueue<{ v: string }>("default-opts-backoff-source", {
      attempts: 3,
      backoff: { type: "custom" },
    });
    queue = q;

    const strategyCalls: number[] = [];
    let attempts = 0;
    q.process(
      async () => {
        attempts++;
        throw new Error("transient");
      },
      {
        backoffStrategy: (attempt) => {
          strategyCalls.push(attempt);
          return 1;
        },
      },
    );

    await q.add("deliver", { v: "x" });

    await waitFor(() => attempts >= 3);
    await waitFor(async () => (await q.count()) === 0);
    // Consulted once per retry — it is the delay's only source.
    expect(strategyCalls).toEqual([1, 2]);
  });

  it("ignores `backoff` in the defaults when the worker declares no strategy", async () => {
    const q = await createQueue<{ v: string }>("default-opts-backoff-inert", {
      attempts: 2,
      backoff: { type: "custom" },
    });
    queue = q;

    let attempts = 0;
    // No worker options at all — so the built-in `1000ms × attempt` fallback
    // is what schedules the retry, `backoff` above notwithstanding.
    q.process(async () => {
      attempts++;
      throw new Error("transient");
    });

    await q.add("deliver", { v: "x" });
    await waitFor(() => attempts >= 1);

    // Well inside the 1s fallback: the second attempt has not fired yet.
    await new Promise((r) => setTimeout(r, 250));
    expect(attempts).toBe(1);

    await waitFor(() => attempts >= 2, 5_000);
    expect(attempts).toBe(2);
  });
});
