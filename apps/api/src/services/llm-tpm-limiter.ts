// SPDX-License-Identifier: Apache-2.0

/**
 * Per-org, per-model token-throughput limiter for `/api/llm-proxy/*`.
 *
 * #427 was an incident where 8 parallel runs in the same org each respected
 * their per-run fan-out cap but collectively blew past the upstream model's
 * TPM ceiling, exhausted the SDK retry budget, and surfaced as silent
 * null-output `success` runs. #429 fixed the per-run side. This service is
 * the platform-side counterpart: a Redis-backed bucket that bounds the
 * cumulative tokens N concurrent runs in the same org can pump into a
 * single model within a 60-second window.
 *
 * Design notes:
 *
 *   - Keyed by `(orgId, modelLabel)` so two orgs never share state and a
 *     fallback model (e.g. agent retries on `gpt-4o-mini`) draws from its
 *     own bucket. Per #431 this is the right behavior.
 *
 *   - Backed by `RateLimiterRedis` when `REDIS_URL` is set, falls back to
 *     `RateLimiterMemory` otherwise — wired through the same
 *     `getRateLimiterFactory()` the rest of the platform uses. The Redis
 *     backend's `consume()` is a Lua-script `incr+pttl`, atomic across N
 *     API instances, which is the whole point of doing this in Redis.
 *
 *   - `rate-limiter-flexible` exposes the underlying primitive as a
 *     fixed-window counter with `points` capacity over `duration` seconds.
 *     For TPM this matches what we want: a 60-second window with a token
 *     ceiling. The "burst" semantics #431 mentions are subsumed by `tpm`
 *     itself — a single call cannot consume more than `tpm` worth, and the
 *     window naturally rolls every 60s.
 *
 *   - Bucket lookup is `tpm_buckets[modelLabel]` (exact match) → `"default"`
 *     → disabled. Operators get one knob per known hot model and one
 *     default for everything else.
 *
 *   - Token estimation is cheap and approximate — `ceil(promptChars / 3.5)
 *     + max_tokens`. This is a traffic-shaping ceiling, not a billing
 *     meter; precise accounting still happens after the upstream call via
 *     `llm_usage`.
 *
 * #433 will turn the structured logs emitted here into proper metrics.
 * Until then, the `info` line on every draw is the observability hook.
 */

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { getRateLimiterFactory } from "../infra/index.ts";
import { getLlmProxyLimits } from "./proxy-limits.ts";
import { logger } from "../lib/logger.ts";

/** 1-minute fixed window — TPM is per definition a 60-second budget. */
const WINDOW_SECONDS = 60;

/**
 * Default `max_tokens` reservation when the caller omits it. OpenAI/
 * Anthropic SDKs both default the response to a generous ceiling when
 * `max_tokens` is unset, so reserving a token estimate of 4096 keeps us
 * conservative without locking out short prompts. This is intentionally
 * NOT operator-configurable — it's a defensive default for the estimator,
 * not a policy knob.
 */
export const DEFAULT_MAX_TOKENS_RESERVATION = 4096;

export interface TpmDrawInput {
  orgId: string;
  /** ResolvedModel.label — the human-facing model name we key the bucket on. */
  modelLabel: string;
  estimatedTokens: number;
}

export type TpmDrawResult =
  | {
      /** True when the bucket allowed the draw. Also true when no bucket is configured. */
      ok: true;
      /** Bucket key consulted, or `null` when no bucket was configured (no-op draw). */
      bucketKey: string | null;
      /** Tokens we charged against the bucket. Zero when no bucket was consulted. */
      consumed: number;
      /** Remaining points in the window. Null when no bucket was consulted. */
      remaining: number | null;
    }
  | {
      ok: false;
      bucketKey: string;
      /**
       * Tokens we attempted to charge — present in the structured 429 body
       * so the caller can see how oversized their request was relative to
       * the bucket and back off intelligently.
       */
      requested: number;
      /** Bucket capacity (TPM ceiling). */
      capacity: number;
      /** Seconds the caller must wait before the window resets. */
      retryAfterSeconds: number;
    };

// Limiter cache keyed by capacity. `rate-limiter-flexible` ties the
// configured `points` to the instance, so a 200k-tpm bucket and a 50k-tpm
// bucket cannot share a limiter; we cache one per distinct capacity.
const limiters = new Map<number, RateLimiterAbstract>();

async function getLimiter(capacity: number): Promise<RateLimiterAbstract> {
  let limiter = limiters.get(capacity);
  if (!limiter) {
    const factory = await getRateLimiterFactory();
    limiter = factory.create(capacity, WINDOW_SECONDS, "rl:llm-tpm:");
    limiters.set(capacity, limiter);
  }
  return limiter;
}

/**
 * Look up the policy (capacity + config key) for a given modelLabel.
 * Returns `null` when neither a specific entry nor a `"default"` entry
 * exists — "no bucket configured, skip the draw". Burst defaults to
 * `tpm` per the #431 contract.
 *
 * Important: `configKey` is purely for observability — it tells us which
 * config row was matched ("gpt-4o" vs "default"). The Redis bucket state
 * itself is ALWAYS keyed on `(orgId, modelLabel)` so two different models
 * sharing the same default capacity still draw from separate buckets.
 * Conflating the two would let one hot model exhaust the default bucket
 * for every other model in the org — exactly the failure mode #431
 * exists to prevent.
 */
function policyFor(modelLabel: string): { configKey: string; capacity: number } | null {
  const { tpm_buckets } = getLlmProxyLimits();
  const specific = tpm_buckets[modelLabel];
  if (specific) {
    return { configKey: modelLabel, capacity: specific.burst ?? specific.tpm };
  }
  const fallback = tpm_buckets["default"];
  if (fallback) {
    return { configKey: "default", capacity: fallback.burst ?? fallback.tpm };
  }
  return null;
}

function redisKeyFor(orgId: string, modelLabel: string): string {
  // `rate-limiter-flexible` already prefixes with `rl:llm-tpm:`; this is
  // the per-call key suffix appended after that prefix. Both dimensions
  // live in this key per the #431 spec — `tpm:${orgId}:${modelLabel}`.
  return `tpm:${orgId}:${modelLabel}`;
}

/**
 * Attempt to draw `estimatedTokens` from the `(orgId, modelLabel)` bucket.
 * Returns the structured result above — callers translate the deny case
 * into a 429 themselves so the proxy can keep the local error path tidy.
 *
 * Never throws on operational errors (Redis hiccup, etc.) — the
 * `rate-limiter-flexible` Redis backend can reject with an `Error` (not a
 * `RateLimiterRes`) when Redis is unreachable. We log and fail open: it
 * is safer for tenants to see one upstream 429 from OpenAI than to lock
 * the whole org out of LLM access because Redis blipped.
 */
export async function drawTpm(input: TpmDrawInput): Promise<TpmDrawResult> {
  const policy = policyFor(input.modelLabel);
  if (!policy) {
    logger.info("llm-tpm: bucket disabled (no draw)", {
      orgId: input.orgId,
      modelLabel: input.modelLabel,
      estimated: input.estimatedTokens,
      denied: false,
    });
    return { ok: true, bucketKey: null, consumed: 0, remaining: null };
  }

  // Clamp the draw to the bucket capacity. A single request larger than
  // the entire bucket would otherwise lock the bucket for the rest of the
  // window — return a clean rejection instead. This is a defensive guard
  // for misconfigured agents emitting million-token contexts; the deny
  // path below still surfaces the original `estimatedTokens` in the
  // structured 429 so the caller knows their request was oversized.
  const limiter = await getLimiter(policy.capacity);
  const charge = Math.max(1, Math.min(input.estimatedTokens, policy.capacity));
  const key = redisKeyFor(input.orgId, input.modelLabel);

  try {
    const res = await limiter.consume(key, charge);
    logger.info("llm-tpm: draw", {
      orgId: input.orgId,
      modelLabel: input.modelLabel,
      bucketKey: input.modelLabel,
      policyKey: policy.configKey,
      estimated: input.estimatedTokens,
      consumed: charge,
      remaining: res.remainingPoints,
      denied: false,
    });
    return {
      ok: true,
      bucketKey: input.modelLabel,
      consumed: charge,
      remaining: res.remainingPoints,
    };
  } catch (rej) {
    // `rate-limiter-flexible` rejects with `RateLimiterRes` when the
    // bucket is exhausted, OR with a raw `Error` when the Redis backend
    // itself fails (connection dropped, Lua script error). Treat the two
    // cases separately: bucket exhaustion is a real deny, infrastructure
    // failure is a fail-open with a warn log.
    if (rej && typeof rej === "object" && "msBeforeNext" in rej) {
      const retryAfter = Math.max(
        1,
        Math.ceil((rej as { msBeforeNext: number }).msBeforeNext / 1000),
      );
      logger.info("llm-tpm: denied", {
        orgId: input.orgId,
        modelLabel: input.modelLabel,
        bucketKey: input.modelLabel,
        policyKey: policy.configKey,
        estimated: input.estimatedTokens,
        capacity: policy.capacity,
        retryAfterSeconds: retryAfter,
        denied: true,
      });
      return {
        ok: false,
        bucketKey: input.modelLabel,
        requested: input.estimatedTokens,
        capacity: policy.capacity,
        retryAfterSeconds: retryAfter,
      };
    }
    logger.warn("llm-tpm: limiter backend error — failing open", {
      orgId: input.orgId,
      modelLabel: input.modelLabel,
      policyKey: policy.configKey,
      estimated: input.estimatedTokens,
      error: rej instanceof Error ? rej.message : String(rej),
    });
    return {
      ok: true,
      bucketKey: input.modelLabel,
      consumed: 0,
      remaining: null,
    };
  }
}

/**
 * Test-only — drop every cached limiter so the next call rebuilds against
 * whatever the test has just installed via `_setProxyLimitsForTesting()`.
 * Pairs with `flushRedis()` in integration tests so the underlying bucket
 * state is also reset.
 */
export function _resetTpmLimiterForTesting(): void {
  limiters.clear();
}
