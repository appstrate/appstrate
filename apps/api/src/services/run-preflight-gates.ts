// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight gates — the checks every run path (platform, remote,
 * scheduled) performs before spending any further resources:
 *
 *   1. Per-org rate limit (Redis token bucket).
 *   2. Per-org concurrency cap.
 *   3. `beforeUsage` module hook (admission policies — usage caps, feature
 *      gates) — run surface.
 *   4. Timeout ceiling — agent manifest's `timeout` capped to the platform
 *      limit. Returns a cloned agent when a cap is applied so callers pass
 *      the capped value into the container env without mutating the DB.
 *
 * Why a dedicated module: platform (`run-pipeline.prepareAndExecuteRun`)
 * and remote (`run-creation.createRun`) used to duplicate all the
 * gates, with the usual drift risk (rate / concurrency / hook ordering).
 * Centralising the checks here guarantees a single change surface.
 */

import type { LoadedPackage } from "../types/index.ts";
import { getPlatformRunLimits } from "./run-limits.ts";
import { checkOrgRunRateLimit } from "./org-run-rate-limit.ts";
import { getRunningRunCountForOrg } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";

export type PreflightGateError = { code: string; message: string; status?: number };

export interface PreflightGatesInput {
  orgId: string;
  agent: LoadedPackage;
  /**
   * Where the run's resolved model comes from, decided SERVER-SIDE by the
   * caller (platform pipeline: `resolveModel(...).isSystemModel`; remote: never
   * resolves a platform model → `null`). Governs the `beforeUsage` admission
   * hook: it fires ONLY for a platform-provided (`"system"`) model — the same
   * rule the chat surface applies (`checkUsageAllowed` → `isSystemModel`).
   *
   *   - `"system"` → platform credential is spent → dispatch `beforeUsage` so a
   *     metering module (cloud) can enforce credit caps.
   *   - `"org"` → the org spends its OWN credential (BYOK / OAuth subscription)
   *     → never platform-metered → skip the hook (spending a run gate here is
   *     the spurious-402 bug this guards against).
   *   - `null` → a remote-origin run resolves no platform model at creation
   *     (the runner executes on its own host with its own model + credentials),
   *     so it is not cheaply determinable whether it will route inference
   *     through the system proxy. We skip the run-surface hook; any system-proxy
   *     inference a remote run does make is metered per-call on the proxy rows
   *     (`credential_source:"system"`), which carry the attribution.
   *   - `undefined` → unresolved (no caller currently omits it) → treated as
   *     non-system → skip.
   */
  modelSource?: "system" | "org" | null;
}

/** Per-sub-gate wall-clock timings (ms), surfaced for the pipeline timing log. */
export interface PreflightGateTimings {
  rateLimitMs: number;
  concurrencyMs: number;
  beforeUsageHookMs: number;
}

export interface PreflightGatesOk {
  ok: true;
  /** Agent potentially cloned with a capped `timeout` — pass this to downstream code. */
  agent: LoadedPackage;
  /** Running run count observed during the concurrency check. Forwarded to `beforeUsage`. */
  runningCount: number;
  /** Sub-gate durations (ms) for the pipeline's per-stage timing log. */
  timings: PreflightGateTimings;
}

export type PreflightGatesResult = PreflightGatesOk | { ok: false; error: PreflightGateError };

/**
 * Run every shared gate in order. Stops at the first rejection and
 * returns a discriminated result — callers map the error code to their
 * transport (HTTP status for routes, schedule fail for cron).
 */
export async function runPreflightGates(input: PreflightGatesInput): Promise<PreflightGatesResult> {
  const { orgId } = input;
  let agent = input.agent;

  const platformLimits = getPlatformRunLimits();

  // 1 + 2. Per-org rate limit (Redis) and concurrency count (SQL) are
  //         independent — fire both concurrently. Rate-limit precedence is
  //         preserved for EVERY outcome, not just graceful ones: the SQL
  //         call's rejection is captured (never thrown inside Promise.all)
  //         and only re-thrown after the rate result has been inspected.
  //         `checkOrgRunRateLimit` itself never throws (its catch degrades
  //         to a graceful rejection), so without the capture a DB blip
  //         during an over-rate burst would win the Promise.all rejection
  //         and turn the caller's 429+Retry-After into a 500 — the exact
  //         load-shedding failure the rate gate exists to absorb. The rate
  //         limiter consumes a token on evaluation regardless of the
  //         concurrency outcome, exactly as the previous sequential order
  //         did.
  let rateLimitMs = 0;
  let concurrencyMs = 0;
  const rateStart = Date.now();
  const concurrencyStart = Date.now();
  const [rateCheck, countOutcome] = await Promise.all([
    checkOrgRunRateLimit(orgId, platformLimits.per_org_global_rate_per_min).then((r) => {
      rateLimitMs = Date.now() - rateStart;
      return r;
    }),
    getRunningRunCountForOrg({ orgId }).then(
      (count) => {
        concurrencyMs = Date.now() - concurrencyStart;
        return { ok: true as const, count };
      },
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  if (!rateCheck.ok) {
    return {
      ok: false,
      error: {
        code: "org_run_rate_limited",
        message: `Organization rate limit reached (${platformLimits.per_org_global_rate_per_min}/min). Retry in ${rateCheck.retryAfterSeconds}s.`,
        status: 429,
      },
    };
  }

  if (!countOutcome.ok) throw countOutcome.error;
  const runningCount = countOutcome.count;

  // Fast pre-check only — NOT the atomic reservation. Two launches can both
  // observe `count < cap` in the window between here and the run INSERT
  // (~1.75s of pipeline work later) and overshoot the cap. The authoritative,
  // atomic enforcement lives in `createRun` (`state/runs.ts`): it re-counts and
  // inserts the run row in ONE transaction under a per-org advisory lock, so
  // admission is serialized per org and the cap holds exactly. This gate stays
  // as a cheap early 429 that rejects most over-cap launches before the
  // pipeline spends any real work.
  if (runningCount >= platformLimits.max_concurrent_per_org) {
    return {
      ok: false,
      error: {
        code: "org_run_concurrency_exceeded",
        message: `Organization concurrent run limit reached (${platformLimits.max_concurrent_per_org}). Wait for in-flight runs to complete.`,
        status: 429,
      },
    };
  }

  // 3. Timeout ceiling — applied before `beforeUsage` so module code sees
  //    the effective timeout (e.g. for pre-charging cost estimation).
  const declaredTimeout = typeof agent.manifest.timeout === "number" ? agent.manifest.timeout : 300;
  if (declaredTimeout > platformLimits.timeout_ceiling_seconds) {
    agent = {
      ...agent,
      manifest: { ...agent.manifest, timeout: platformLimits.timeout_ceiling_seconds },
    };
  }

  // 4. `beforeUsage` module hook (run surface) — ONLY for platform-provided
  //    ("system") models. A run on the org's OWN model (BYOK / OAuth
  //    subscription) or a remote-origin run (own host + credentials) spends no
  //    platform credit, so gating it here is the spurious-402 the model-source
  //    check prevents. Mirrors the chat surface (`checkUsageAllowed`). See
  //    `PreflightGatesInput.modelSource` for the full per-value rationale.
  let beforeUsageHookMs = 0;
  if (input.modelSource === "system" && hasHook("beforeUsage")) {
    const hookStart = Date.now();
    const rejection = await callHook("beforeUsage", {
      orgId,
      context: "run",
      packageId: agent.id,
      runningCount,
    });
    beforeUsageHookMs = Date.now() - hookStart;
    if (rejection) {
      return {
        ok: false,
        error: { code: rejection.code, message: rejection.message, status: rejection.status },
      };
    }
  }

  return {
    ok: true,
    agent,
    runningCount,
    timings: { rateLimitMs, concurrencyMs, beforeUsageHookMs },
  };
}
