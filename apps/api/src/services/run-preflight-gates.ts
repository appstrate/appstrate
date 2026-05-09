// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight gates — the checks every run path (platform, remote,
 * scheduled) performs before spending any further resources:
 *
 *   1. Per-org rate limit (Redis token bucket).
 *   2. Per-org concurrency cap.
 *   3. `beforeRun` module hook (quota / billing / feature gates).
 *   4. Provider-status snapshot (persisted on the `runs` row for audit).
 *   5. Timeout ceiling — agent manifest's `timeout` capped to the platform
 *      limit. Returns a cloned agent when a cap is applied so callers pass
 *      the capped value into the container env without mutating the DB.
 *
 * Why a dedicated module: platform (`run-pipeline.prepareAndExecuteRun`)
 * and remote (`run-creation.createRemoteRun`) used to duplicate all five
 * gates, with the usual drift risk (rate / concurrency / hook ordering).
 * Centralising the checks here guarantees a single change surface.
 */

import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import type { RunProviderSnapshot } from "@appstrate/shared-types";
import { getPlatformRunLimits } from "./run-limits.ts";
import { checkOrgRunRateLimit } from "./org-run-rate-limit.ts";
import { getRunningRunCountForOrg } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { resolveProviderStatuses } from "./connection-manager/status.ts";

export type PreflightGateError = { code: string; message: string; status?: number };

export interface PreflightGatesInput {
  orgId: string;
  applicationId: string;
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
}

export interface PreflightGatesOk {
  ok: true;
  /** Agent potentially cloned with a capped `timeout` — pass this to downstream code. */
  agent: LoadedPackage;
  /** Running run count observed during the concurrency check. Forwarded to `beforeRun`. */
  runningCount: number;
  /** Provider-status snapshot for the `runs` row; `undefined` when the agent has no providers. */
  providerStatusSnapshots: RunProviderSnapshot[] | undefined;
}

export type PreflightGatesResult = PreflightGatesOk | { ok: false; error: PreflightGateError };

/**
 * Run every shared gate in order. Stops at the first rejection and
 * returns a discriminated result — callers map the error code to their
 * transport (HTTP status for routes, schedule fail for cron).
 */
export async function runPreflightGates(input: PreflightGatesInput): Promise<PreflightGatesResult> {
  const { orgId, applicationId, providerProfiles } = input;
  let agent = input.agent;

  const platformLimits = getPlatformRunLimits();

  // 1. Per-org rate limit.
  const rateCheck = await checkOrgRunRateLimit(orgId, platformLimits.per_org_global_rate_per_min);
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

  // 2. Per-org concurrency.
  const runningCount = await getRunningRunCountForOrg({ orgId });
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

  // 3. Timeout ceiling — applied before `beforeRun` so module code sees
  //    the effective timeout (e.g. for pre-charging cost estimation).
  const declaredTimeout = typeof agent.manifest.timeout === "number" ? agent.manifest.timeout : 300;
  if (declaredTimeout > platformLimits.timeout_ceiling_seconds) {
    agent = {
      ...agent,
      manifest: { ...agent.manifest, timeout: platformLimits.timeout_ceiling_seconds },
    };
  }

  // 4. `beforeRun` module hook.
  if (hasHook("beforeRun")) {
    const rejection = await callHook("beforeRun", {
      orgId,
      packageId: agent.id,
      runningCount,
    });
    if (rejection) {
      return {
        ok: false,
        error: { code: rejection.code, message: rejection.message, status: rejection.status },
      };
    }
  }

  // 5. Provider-status snapshot.
  let providerStatusSnapshots: RunProviderSnapshot[] | undefined;
  const manifestProviders = resolveManifestProviders(agent.manifest);
  if (manifestProviders.length > 0) {
    const statuses = await resolveProviderStatuses(
      { orgId, applicationId },
      manifestProviders,
      providerProfiles,
    );
    providerStatusSnapshots = statuses.map((s) => ({
      id: s.id,
      status: s.status,
      source: s.source,
      profileName: s.profileName,
      profileOwnerName: s.profileOwnerName,
      ...(s.scopesSufficient != null ? { scopesSufficient: s.scopesSufficient } : {}),
    }));
  }

  return { ok: true, agent, runningCount, providerStatusSnapshots };
}
