// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for infrastructure adapters.
 *
 * Verifies that PubSub, Cache, RateLimit, and Queue adapters work correctly
 * in the current environment mode (Redis or local). These tests exercise the
 * real factory functions (getPubSub, getCache, etc.) and validate end-to-end
 * behavior through the adapter interface.
 *
 * When REDIS_URL is set: tests run against Redis-backed implementations.
 * When REDIS_URL is absent: tests run against in-memory implementations.
 */

import { describe, it, expect, afterAll } from "bun:test";
import {
  getPubSub,
  getCache,
  getRateLimiterFactory,
  shutdownInfra,
} from "../../../src/infra/index.ts";
import { hasRedis } from "../../../src/infra/mode.ts";
import { createQueue, PermanentJobError } from "../../../src/infra/queue/index.ts";
import type { QueueJob } from "../../../src/infra/queue/index.ts";

const mode = hasRedis() ? "Redis" : "local";

afterAll(async () => {
  await shutdownInfra();
});

// ─── PubSub ──────────────────────────────────────────────────

describe(`PubSub (${mode})`, () => {
  it("delivers messages to subscribers", async () => {
    const pubsub = await getPubSub();
    const received: string[] = [];

    await pubsub.subscribe("test:infra:pubsub", (msg) => received.push(msg));
    await pubsub.publish("test:infra:pubsub", "hello");
    await pubsub.publish("test:infra:pubsub", "world");

    // Redis pub/sub is async — give a small window for delivery
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toContain("hello");
    expect(received).toContain("world");

    await pubsub.unsubscribe("test:infra:pubsub");
  });

  it("stops delivering after unsubscribe", async () => {
    const pubsub = await getPubSub();
    const received: string[] = [];

    await pubsub.subscribe("test:infra:unsub", (msg) => received.push(msg));
    await pubsub.publish("test:infra:unsub", "before");
    await new Promise((r) => setTimeout(r, 50));
    await pubsub.unsubscribe("test:infra:unsub");
    await pubsub.publish("test:infra:unsub", "after");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toContain("before");
    expect(received).not.toContain("after");
  });
});

// ─── Cache ───────────────────────────────────────────────────

describe(`Cache (${mode})`, () => {
  it("stores and retrieves values", async () => {
    const cache = await getCache();
    await cache.set("test:infra:cache:k1", "value1");
    expect(await cache.get("test:infra:cache:k1")).toBe("value1");
    await cache.del("test:infra:cache:k1");
  });

  it("returns null for missing keys", async () => {
    const cache = await getCache();
    expect(await cache.get("test:infra:cache:missing")).toBeNull();
  });

  it("NX prevents overwrite", async () => {
    const cache = await getCache();
    await cache.set("test:infra:cache:nx", "first");
    const overwritten = await cache.set("test:infra:cache:nx", "second", { nx: true });
    expect(overwritten).toBe(false);
    expect(await cache.get("test:infra:cache:nx")).toBe("first");
    await cache.del("test:infra:cache:nx");
  });

  it("TTL expires entries", async () => {
    const cache = await getCache();
    await cache.set("test:infra:cache:ttl", "ephemeral", { ttlSeconds: 1 });
    expect(await cache.get("test:infra:cache:ttl")).toBe("ephemeral");
    await new Promise((r) => setTimeout(r, 1200));
    expect(await cache.get("test:infra:cache:ttl")).toBeNull();
  });

  it("del removes keys", async () => {
    const cache = await getCache();
    await cache.set("test:infra:cache:del", "doomed");
    await cache.del("test:infra:cache:del");
    expect(await cache.get("test:infra:cache:del")).toBeNull();
  });
});

// ─── RateLimit ───────────────────────────────────────────────

describe(`RateLimit (${mode})`, () => {
  it("allows requests within the limit", async () => {
    const factory = await getRateLimiterFactory();
    const limiter = factory.create(5, 60, "test:infra:rl:");

    const result = await limiter.consume("test-key-1");
    expect(result.remainingPoints).toBe(4);
    expect(result.consumedPoints).toBe(1);
  });

  it("rejects when limit is exhausted", async () => {
    const factory = await getRateLimiterFactory();
    const limiter = factory.create(2, 60, "test:infra:rl2:");

    await limiter.consume("test-key-2");
    await limiter.consume("test-key-2");

    try {
      await limiter.consume("test-key-2");
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});

// ─── Queue ───────────────────────────────────────────────────

describe(`Queue (${mode})`, () => {
  it("processes jobs through the queue", async () => {
    const queue = await createQueue<{ value: string }>("test-infra-queue");
    const processed: string[] = [];

    queue.process(async (job: QueueJob<{ value: string }>) => {
      processed.push(job.data.value);
    });

    await queue.add("test-job-1", { value: "alpha" });
    await queue.add("test-job-2", { value: "beta" });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 500));

    expect(processed).toContain("alpha");
    expect(processed).toContain("beta");

    await queue.shutdown();
  });

  it("retries failed jobs", async () => {
    const queue = await createQueue<{ value: string }>("test-infra-retry");
    let attempts = 0;

    queue.process(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
      },
      { concurrency: 1 },
    );

    await queue.add("retry-job", { value: "x" }, { attempts: 3 });

    // Wait for retries
    await new Promise((r) => setTimeout(r, 5000));

    expect(attempts).toBeGreaterThanOrEqual(3);

    await queue.shutdown();
  }, 10000);

  it("does not retry PermanentJobError", async () => {
    const queue = await createQueue<{ value: string }>("test-infra-perm");
    let attempts = 0;

    queue.process(async () => {
      attempts++;
      throw new PermanentJobError("permanent");
    });

    await queue.add("perm-job", { value: "x" }, { attempts: 5 });

    await new Promise((r) => setTimeout(r, 1000));

    expect(attempts).toBe(1);

    await queue.shutdown();
  });

  it("upsert and remove scheduler do not throw", async () => {
    const queue = await createQueue<{ value: string }>("test-infra-sched");

    queue.process(async () => {});

    await queue.upsertScheduler(
      "test-sched-1",
      { pattern: "0 0 * * *", tz: "UTC" },
      { name: "daily-job", data: { value: "scheduled" } },
    );

    await queue.removeScheduler("test-sched-1");
    await queue.shutdown();
  });
});
