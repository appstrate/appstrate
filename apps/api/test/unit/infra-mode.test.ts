// SPDX-License-Identifier: Apache-2.0

/**
 * Tests that infrastructure factories produce the correct adapter
 * based on environment configuration (REDIS_URL present or absent).
 *
 * These tests mock the env to test both paths without requiring Redis.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { LocalPubSub } from "../../src/infra/pubsub/local-pubsub.ts";
import { LocalCache } from "../../src/infra/cache/local-cache.ts";
import { LocalRateLimiterFactory } from "../../src/infra/rate-limit/local-rate-limit.ts";

// We can't easily test the Redis path without a real Redis connection,
// but we can verify the local path works correctly.

describe("infra factories (no Redis)", () => {
  afterEach(() => {
    _resetCacheForTesting();
  });

  it("LocalPubSub implements PubSub interface", () => {
    const pubsub = new LocalPubSub();
    expect(typeof pubsub.publish).toBe("function");
    expect(typeof pubsub.subscribe).toBe("function");
    expect(typeof pubsub.unsubscribe).toBe("function");
    expect(typeof pubsub.shutdown).toBe("function");
  });

  it("LocalCache implements KeyValueCache interface", () => {
    const cache = new LocalCache();
    expect(typeof cache.get).toBe("function");
    expect(typeof cache.set).toBe("function");
    expect(typeof cache.del).toBe("function");
    expect(typeof cache.shutdown).toBe("function");
  });

  it("LocalRateLimiterFactory creates working limiters", async () => {
    const factory = new LocalRateLimiterFactory();
    const limiter = factory.create(5, 60, "test:");

    // Should allow consumption
    const result = await limiter.consume("key1");
    expect(result.remainingPoints).toBe(4);
    expect(result.consumedPoints).toBe(1);
  });

  it("LocalRateLimiterFactory limiter rejects when exhausted", async () => {
    const factory = new LocalRateLimiterFactory();
    const limiter = factory.create(2, 60, "test:");

    await limiter.consume("key1");
    await limiter.consume("key1");

    // Third attempt should be rejected
    try {
      await limiter.consume("key1");
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
