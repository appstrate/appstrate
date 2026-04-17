// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org global run rate limit.
 *
 * Keyed by orgId (NOT by user / API key / path) so a single org cannot
 * exhaust platform capacity across its members and service accounts.
 * Enforced at the pipeline level (not middleware) because the orgId is
 * already resolved by the time we reach `prepareAndExecuteRun()`, and
 * because classic + inline + scheduled runs share the same limiter.
 *
 * Redis-backed in multi-instance deployments; single-instance deployments
 * fall back to the in-memory implementation selected by
 * `getRateLimiterFactory()`.
 */

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { getRateLimiterFactory } from "../infra/index.ts";

interface OrgRateLimitDenied {
  ok: false;
  retryAfterSeconds: number;
}

interface OrgRateLimitAllowed {
  ok: true;
}

export type OrgRateLimitResult = OrgRateLimitDenied | OrgRateLimitAllowed;

let limiter: RateLimiterAbstract | null = null;
let currentCap = -1;

async function getLimiter(cap: number): Promise<RateLimiterAbstract> {
  if (!limiter || cap !== currentCap) {
    const factory = await getRateLimiterFactory();
    limiter = factory.create(cap, 60, "rl:org-run:");
    currentCap = cap;
  }
  return limiter;
}

/**
 * Consume one point for `orgId`. Returns `{ ok: true }` when under the
 * cap, or `{ ok: false, retryAfterSeconds }` when rejected. Never throws.
 */
export async function checkOrgRunRateLimit(
  orgId: string,
  cap: number,
): Promise<OrgRateLimitResult> {
  const l = await getLimiter(cap);
  try {
    await l.consume(orgId);
    return { ok: true };
  } catch (rej) {
    // Cannot assume rej is a proper object — rate-limiter-flexible sometimes
    // rejects with Error for Redis mishaps.
    const retryAfter =
      rej && typeof rej === "object" && "msBeforeNext" in rej
        ? Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000)
        : 60;
    return { ok: false, retryAfterSeconds: retryAfter };
  }
}

/** Test-only — drop the cached limiter to force the next call to rebuild. */
export function _resetOrgRunRateLimitForTesting(): void {
  limiter = null;
  currentCap = -1;
}
