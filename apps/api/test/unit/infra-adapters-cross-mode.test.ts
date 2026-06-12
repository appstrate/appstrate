// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-mode adapter tests — verifies that BOTH local and Redis implementations
 * work correctly through the same interface contract.
 *
 * Tests local adapters directly (no Redis needed).
 * Runs as unit tests — no Docker, no preload, no migrations.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { LocalPubSub } from "../../src/infra/pubsub/local-pubsub.ts";
import { LocalCache } from "../../src/infra/cache/local-cache.ts";
import { LocalRateLimiterFactory } from "../../src/infra/rate-limit/local-rate-limit.ts";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import { PermanentJobError } from "../../src/infra/queue/interface.ts";
import type { PubSub } from "../../src/infra/pubsub/interface.ts";
import type { KeyValueCache } from "../../src/infra/cache/interface.ts";
import type { RateLimiterFactory } from "../../src/infra/rate-limit/interface.ts";
import type { JobQueue, QueueJob } from "../../src/infra/queue/interface.ts";

// ---------------------------------------------------------------------------
// Shared test suite — runs against any adapter implementation
// ---------------------------------------------------------------------------

/** Poll `predicate` every 10ms until it holds (or fail after `timeoutMs`). */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function pubsubSuite(name: string, create: () => PubSub) {
  describe(`PubSub (${name})`, () => {
    let ps: PubSub;
    afterAll(async () => ps?.shutdown());

    it("delivers messages", async () => {
      ps = create();
      const received: string[] = [];
      await ps.subscribe("ch1", (msg) => received.push(msg));
      await ps.publish("ch1", "a");
      await ps.publish("ch1", "b");
      await waitFor(() => received.length === 2);
      expect(received).toEqual(["a", "b"]);
      await ps.unsubscribe("ch1");
    });

    it("stops after unsubscribe", async () => {
      ps = create();
      const received: string[] = [];
      await ps.subscribe("ch2", (msg) => received.push(msg));
      await ps.publish("ch2", "before");
      await waitFor(() => received.length === 1);
      await ps.unsubscribe("ch2");
      // LocalPubSub delivers synchronously inside publish(), so once it
      // resolves the (absent) delivery has already happened — no settle wait.
      await ps.publish("ch2", "after");
      expect(received).toEqual(["before"]);
    });
  });
}

function cacheSuite(name: string, create: () => KeyValueCache) {
  describe(`Cache (${name})`, () => {
    let c: KeyValueCache;
    afterAll(async () => c?.shutdown());

    it("get/set/del", async () => {
      c = create();
      await c.set("k", "v");
      expect(await c.get("k")).toBe("v");
      await c.del("k");
      expect(await c.get("k")).toBeNull();
    });

    it("NX prevents overwrite", async () => {
      c = create();
      await c.set("nx", "first");
      expect(await c.set("nx", "second", { nx: true })).toBe(false);
      expect(await c.get("nx")).toBe("first");
      await c.del("nx");
    });

    it("TTL expires", async () => {
      c = create();
      await c.set("ttl", "val", { ttlSeconds: 1 });
      expect(await c.get("ttl")).toBe("val");
      // LocalCache computes expiry from Date.now() — pin the clock 1.1s
      // ahead instead of sleeping past the real TTL.
      const realNow = Date.now;
      Date.now = () => realNow() + 1_100;
      try {
        expect(await c.get("ttl")).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it("returns null for missing", async () => {
      c = create();
      expect(await c.get("missing")).toBeNull();
    });
  });
}

function rateLimitSuite(name: string, create: () => RateLimiterFactory) {
  const uid = Date.now().toString(36);

  describe(`RateLimit (${name})`, () => {
    it("allows within limit", async () => {
      const limiter = create().create(5, 60, `test:${uid}:a:`);
      const res = await limiter.consume("k");
      expect(res.remainingPoints).toBe(4);
    });

    it("rejects when exhausted", async () => {
      const limiter = create().create(2, 60, `test:${uid}:b:`);
      await limiter.consume("k");
      await limiter.consume("k");
      await expect(limiter.consume("k")).rejects.toBeDefined();
    });
  });
}

function queueSuite(name: string, create: () => JobQueue<{ v: string }>) {
  describe(`Queue (${name})`, () => {
    it("processes jobs", async () => {
      const q = create();
      const processed: string[] = [];
      q.process(async (job: QueueJob<{ v: string }>) => {
        processed.push(job.data.v);
      });
      await q.add("j1", { v: "a" });
      await q.add("j2", { v: "b" });
      await waitFor(() => processed.includes("a") && processed.includes("b"));
      expect(processed).toContain("a");
      expect(processed).toContain("b");
      await q.shutdown();
    });

    it("does not retry PermanentJobError", async () => {
      const q = create();
      let attempts = 0;
      q.process(async () => {
        attempts++;
        throw new PermanentJobError("stop");
      });
      await q.add("perm", { v: "x" }, { attempts: 5 });
      await waitFor(() => attempts >= 1);
      // A pending retry keeps the job active (the backoff timer is awaited
      // inside the queue's executeJob), so a fully drained queue proves no
      // retry was scheduled — stronger than the old fixed 500ms sleep,
      // which ended before the 1s first-retry backoff would have fired.
      await waitFor(async () => (await q.count()) === 0);
      expect(attempts).toBe(1);
      await q.shutdown();
    });
  });
}

// ---------------------------------------------------------------------------
// Run suites against local adapters
// ---------------------------------------------------------------------------

pubsubSuite("local", () => new LocalPubSub());
cacheSuite("local", () => new LocalCache());
rateLimitSuite("local", () => new LocalRateLimiterFactory());
queueSuite("local", () => new LocalQueue<{ v: string }>("test-q"));
