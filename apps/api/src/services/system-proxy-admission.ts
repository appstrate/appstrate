// SPDX-License-Identifier: Apache-2.0

/**
 * Admission gate for platform-paid calls that enter through `/api/llm-proxy`.
 *
 * Platform-origin runs using a system model and chat turns are gated before
 * launch, but a remote run chooses its model later on its own host. The proxy
 * is therefore the first place that can know the remote call resolved to a
 * system preset. This seam applies the module `beforeUsage` hook immediately
 * before the upstream request, using only server-validated context. First-party
 * chat already owns that hook at turn admission; its signed loopback context
 * is validated here without dispatching the hook a second time.
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
      modelSource: string | null;
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

  // A platform-origin run on a SYSTEM model was already admitted once at
  // preflight (run-preflight-gates.ts). Its per-call proxy usage stays
  // attributed, but re-dispatching the hook here would gate the same run twice
  // and duplicate quota reads on every LLM call.
  //
  // `runOrigin === "platform"` alone is NOT proof of prior admission: BYOK
  // platform runs (`modelSource === "org"`) and legacy/unresolved rows
  // (`modelSource === null`) deliberately skipped the system-usage hook. If one
  // of those run ids is later attached to a raw system-preset proxy request, it
  // must be admitted here just like a remote run. Otherwise an llm-proxy caller
  // could use an active BYOK run as a billing context to bypass a quota rejection.
  const admittedAtPreflight =
    args.usageContext.runOrigin === "platform" && args.usageContext.modelSource === "system";
  if (admittedAtPreflight) return;

  const params = {
    orgId: args.orgId,
    context: "run" as const,
    packageId: args.usageContext.packageId,
    // The referenced run already exists and the route verified that it is
    // active, so the DB count normally includes it. Keep a floor of one
    // against a status/count race.
    runningCount: Math.max(1, await getRunningRunCountForOrg({ orgId: args.orgId })),
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
