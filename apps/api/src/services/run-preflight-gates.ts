// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight gates — the checks every run path (platform, remote,
 * scheduled) performs before spending any further resources:
 *
 *   1. Per-org rate limit (Redis token bucket).
 *   2. Per-org concurrency cap.
 *   3. Timeout ceiling — agent manifest's `timeout` capped to the platform
 *      limit. Returns a cloned agent when a cap is applied so callers pass
 *      the capped value into the container env without mutating the DB.
 *   4. `beforeUsage` module hook (admission policies — usage caps, feature
 *      gates) — run surface. Runs last of the four so it is told the EFFECTIVE
 *      (post-ceiling) timeout and the observed in-flight count.
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
   * Whose credential pays for the inference this run performs, decided
   * SERVER-SIDE by the caller (platform pipeline: `resolveModel(...)
   * .isSystemModel`; remote: never resolves a platform model → `null`).
   *
   * This is a FACT reported to `beforeUsage`, NOT a decision about whether the
   * hook fires — the hook fires on every run. A module reads it to quote the
   * MODEL component of the operation:
   *
   *   - `"system"` → a platform-supplied credential is spent (a
   *     `SYSTEM_PROVIDER_KEYS` entry / system preset). The platform funds the
   *     model component.
   *   - `"org"` → the org spends its OWN credential (BYOK API key or OAuth
   *     subscription). The platform funds no model component — a module that
   *     only meters platform-supplied inference quotes zero here, which is what
   *     keeps a BYOK run from taking a spurious 402.
   *   - `null` → a remote-origin run resolves no platform model at creation
   *     (the runner executes on its own host with its own model + credentials),
   *     so the fact is genuinely not determinable here. Not a coverage gap: any
   *     inference such a run later routes through the platform's system proxy
   *     is admitted at the proxy seam (`system-proxy-admission.ts`), where the
   *     credential source IS known, and metered per-call on the proxy ledger
   *     rows (`credential_source:"system"`).
   *
   * Naming: matches the `llm_usage.credential_source` ledger column a metering
   * module reconciles against. The `runs.model_source` DB column is the same
   * concept under an older, persisted name — deliberately not renamed.
   */
  credentialSource: "system" | "org" | null;
  /**
   * Whose compute runs the work — the other neutral fact `beforeUsage` quotes
   * against. `"platform"` for a run executing in platform-operated isolation (a
   * sandbox container / microVM), `"remote"` when the caller supplies the host
   * and the platform contributes no compute.
   *
   * Reported separately from {@link credentialSource} because the two are
   * independent: a BYOK run can still occupy platform compute, and a
   * platform-credential run can execute on a caller-supplied host.
   */
  executionPlane: "platform" | "remote";
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

  // 3. Timeout ceiling — applied BEFORE `beforeUsage` (and computed here, not
  //    after) so the hook is told the run's EFFECTIVE compute bound, not the
  //    manifest's wish. An agent declaring a timeout above the platform ceiling
  //    can never occupy compute for longer than the ceiling, so quoting it on
  //    the declared value would over-charge.
  const declaredTimeout = typeof agent.manifest.timeout === "number" ? agent.manifest.timeout : 300;
  const effectiveTimeoutSeconds = Math.min(declaredTimeout, platformLimits.timeout_ceiling_seconds);
  if (declaredTimeout > platformLimits.timeout_ceiling_seconds) {
    agent = {
      ...agent,
      manifest: { ...agent.manifest, timeout: platformLimits.timeout_ceiling_seconds },
    };
  }

  // 4. `beforeUsage` module hook (run surface) — dispatched for EVERY run,
  //    whatever its credential source or execution plane.
  //
  //    The platform used to decide here that a non-`"system"` model was free
  //    and skip the hook entirely. That hard-coded "BYOK ⇒ free", which is only
  //    true while platform compute is unbilled: a BYOK run on the platform
  //    plane still occupies a sandbox the platform pays for. So the platform
  //    now reports neutral FACTS — who funds the credential
  //    (`credentialSource`), who funds the compute (`executionPlane`), and the
  //    upper bound on that compute (`timeoutSeconds`) — and the module quotes
  //    the operation and decides. A module that only meters platform-supplied
  //    inference simply quotes zero for a BYOK run, which is what keeps the
  //    spurious-402 fixed without the platform pre-classifying anything.
  //
  //    Cost of dispatching unconditionally: a module now sees runs it may quote
  //    at zero. That is deliberate — it is the module's job to short-circuit a
  //    fully self-funded operation (neither platform credential nor platform
  //    compute) before it reads any billing state.
  let beforeUsageHookMs = 0;
  if (hasHook("beforeUsage")) {
    const hookStart = Date.now();
    const rejection = await callHook("beforeUsage", {
      orgId,
      context: "run",
      packageId: agent.id,
      // The DB count is observed before this run is inserted. Admission needs
      // the projected in-flight count INCLUDING the run being considered;
      // otherwise the first run of an org is checked with a zero-cost estimate.
      runningCount: runningCount + 1,
      credentialSource: input.credentialSource,
      executionPlane: input.executionPlane,
      // Post-ceiling: the real upper bound on platform compute time. A run
      // admitted here always owns its compute quote — the proxy seam passes
      // `null` precisely so it does not quote this same run's compute twice.
      timeoutSeconds: effectiveTimeoutSeconds,
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
