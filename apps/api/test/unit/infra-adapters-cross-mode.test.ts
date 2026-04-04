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
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toEqual(["a", "b"]);
      await ps.unsubscribe("ch1");
    });

    it("stops after unsubscribe", async () => {
      ps = create();
      const received: string[] = [];
      await ps.subscribe("ch2", (msg) => received.push(msg));
      await ps.publish("ch2", "before");
      await new Promise((r) => setTimeout(r, 50));
      await ps.unsubscribe("ch2");
      await ps.publish("ch2", "after");
      await new Promise((r) => setTimeout(r, 50));
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
      await new Promise((r) => setTimeout(r, 1100));
      expect(await c.get("ttl")).toBeNull();
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
      q.process(async (job: QueueJob<{ v: string }>) => processed.push(job.data.v));
      await q.add("j1", { v: "a" });
      await q.add("j2", { v: "b" });
      await new Promise((r) => setTimeout(r, 300));
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
      await new Promise((r) => setTimeout(r, 500));
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
