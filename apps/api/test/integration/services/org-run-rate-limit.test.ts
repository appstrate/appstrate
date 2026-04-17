// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org global run rate limiter. Redis-backed in
 * multi-instance deployments, in-memory otherwise — the test environment
 * uses whichever factory the preload selected.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  checkOrgRunRateLimit,
  _resetOrgRunRateLimitForTesting,
} from "../../../src/services/org-run-rate-limit.ts";
import { flushRedis } from "../../helpers/redis.ts";

describe("checkOrgRunRateLimit", () => {
  beforeEach(async () => {
    _resetOrgRunRateLimitForTesting();
    await flushRedis();
  });

  it("allows consumption up to the cap, rejects the next request with retryAfterSeconds", async () => {
    const orgId = `org_${crypto.randomUUID()}`;
    const cap = 3;

    for (let i = 0; i < cap; i++) {
      const res = await checkOrgRunRateLimit(orgId, cap);
      expect(res.ok).toBe(true);
    }

    const denied = await checkOrgRunRateLimit(orgId, cap);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("isolates buckets by orgId", async () => {
    const orgA = `org_${crypto.randomUUID()}`;
    const orgB = `org_${crypto.randomUUID()}`;

    const a1 = await checkOrgRunRateLimit(orgA, 1);
    expect(a1.ok).toBe(true);

    // orgA exhausted; orgB must still pass.
    const a2 = await checkOrgRunRateLimit(orgA, 1);
    expect(a2.ok).toBe(false);

    const b1 = await checkOrgRunRateLimit(orgB, 1);
    expect(b1.ok).toBe(true);
  });

  it("_resetOrgRunRateLimitForTesting drops the cached limiter so a new cap takes effect", async () => {
    const orgId = `org_${crypto.randomUUID()}`;

    // Build a limiter with cap=1.
    const first = await checkOrgRunRateLimit(orgId, 1);
    expect(first.ok).toBe(true);

    // Without a reset, the cached limiter ignores a new cap argument —
    // it returns the same instance. Prove it by resetting AND flushing
    // the redis backing bucket, then asking for a fresh limit.
    _resetOrgRunRateLimitForTesting();
    await flushRedis();

    // With cap=2, two fresh consumes should pass.
    expect((await checkOrgRunRateLimit(orgId, 2)).ok).toBe(true);
    expect((await checkOrgRunRateLimit(orgId, 2)).ok).toBe(true);
    expect((await checkOrgRunRateLimit(orgId, 2)).ok).toBe(false);
  });
});
