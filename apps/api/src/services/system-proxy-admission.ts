// SPDX-License-Identifier: Apache-2.0

/**
 * Admission gate for platform-paid calls that enter through `/api/llm-proxy`.
 *
 * Runs and chat turns are admitted before launch, but only a call whose MODEL
 * component was quoted there is covered: a remote run chooses its model later
 * on its own host, and a platform BYOK run was quoted with no model component
 * at all. The proxy is the first place that can know either of those resolved
 * to a platform-supplied system preset, so this seam applies the module
 * `beforeUsage` hook immediately before the upstream request, using only
 * server-validated context. First-party chat already owns that hook at turn
 * admission; its signed loopback context is validated here without dispatching
 * the hook a second time.
 */

import type { ResolvedModel } from "./org-models.ts";
import { getRunningRunCountForOrg } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { ApiError } from "../lib/errors.ts";

export type SystemProxyUsageContext =
  | {
      context: "run";
      packageId: string;
      runOrigin: "platform" | "remote";
      /**
       * The referenced run's persisted credential source — the raw
       * `runs.model_source` column value (same concept, older persisted name;
       * the column is deliberately not renamed). Used ONLY to decide whether
       * this run's MODEL component was already quoted at preflight.
       */
      credentialSource: string | null;
    }
  | { context: "chat"; sessionId: string | null }
  | null;

export async function enforceSystemProxyAdmission(args: {
  orgId: string;
  resolved: ResolvedModel;
  usageContext: SystemProxyUsageContext;
}): Promise<void> {
  // BYOK/API-key presets spend the org's own credential, and OSS deployments
  // may intentionally expose system presets without a billing module.
  if (!args.resolved.isSystemModel || !hasHook("beforeUsage")) return;

  // A platform-paid raw proxy call must belong to a validated product surface:
  // X-Run-Id for an agent, or the signed first-party loopback identity for
  // chat. Refusing an unattributed system call prevents a headless API key from
  // bypassing the run/chat quota gates while still allowing BYOK proxy calls.
  if (!args.usageContext) {
    throw new ApiError({
      status: 400,
      code: "usage_context_required",
      title: "Usage Context Required",
      detail:
        "Platform-provided model calls must include a valid X-Run-Id or originate from the first-party chat loopback.",
    });
  }

  // `checkUsageAllowed` already called `beforeUsage` once for this exact turn
  // before minting the inference loopback token. Calling it again here would
  // duplicate hook side effects and quota reads. The signed loopback identity
  // is still load-bearing: it is what distinguishes chat from an unattributed
  // raw proxy call.
  if (args.usageContext.context === "chat") return;

  // Was this run's MODEL component already quoted when the run was admitted?
  //
  // Every platform run is now admitted at preflight (run-preflight-gates.ts) —
  // the hook fires whatever the run's credential source. But it is admitted
  // with THAT run's facts, and only a `"system"` run reported a
  // platform-supplied credential, i.e. only a `"system"` run had a MODEL
  // component quoted. Re-dispatching for it here would gate the same
  // platform-supplied inference twice and duplicate quota reads on every LLM
  // call, so it returns early.
  //
  // A platform BYOK run (`credentialSource === "org"`) or a legacy/unresolved
  // row (`null`) was quoted with a ZERO model component — correctly, since its
  // own inference spends the org's credential. That makes it a bypass vector:
  // an llm-proxy caller can attach such a run id to a raw SYSTEM-preset request
  // and launder platform-funded inference through a run that was quoted at
  // zero, defeating a quota rejection. Those runs must therefore be admitted
  // here, exactly like a remote run. The expression is unchanged from when the
  // platform skipped the hook for non-system runs — but it now means "was the
  // model component already quoted", not "did the hook already run".
  const admittedAtPreflight =
    args.usageContext.runOrigin === "platform" && args.usageContext.credentialSource === "system";
  if (admittedAtPreflight) return;

  const params = {
    orgId: args.orgId,
    context: "run" as const,
    packageId: args.usageContext.packageId,
    // The referenced run already exists and the route verified that it is
    // active, so the DB count normally includes it. Keep a floor of one
    // against a status/count race.
    runningCount: Math.max(1, await getRunningRunCountForOrg({ orgId: args.orgId })),
    // This seam only runs for a resolved SYSTEM preset (`resolved.isSystemModel`
    // is checked above), so the call being admitted is platform-funded
    // inference by construction — whatever credential the RUN itself declared.
    credentialSource: "system" as const,
    executionPlane:
      args.usageContext.runOrigin === "platform" ? ("platform" as const) : ("remote" as const),
    // Not determinable at this seam — the proxy holds no agent manifest — and
    // deliberately not faked. `null` means "contribute no compute component
    // here": this seam admits the inference of an ALREADY-RUNNING run whose
    // compute was either quoted at its own preflight (platform plane) or is not
    // platform-funded at all (remote plane). Passing a guessed duration, or `0`
    // as a sentinel, would double-count that same run's compute.
    timeoutSeconds: null,
  };

  const rejection = await callHook("beforeUsage", params);
  if (!rejection) return;

  throw new ApiError({
    status: rejection.status ?? 403,
    code: rejection.code,
    title: rejection.status === 402 ? "Payment Required" : "Usage Rejected",
    detail: rejection.message,
  });
}
