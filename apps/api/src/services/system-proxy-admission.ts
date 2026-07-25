// SPDX-License-Identifier: Apache-2.0

/**
 * Admission gate for platform-paid calls that enter through `/api/llm-proxy`.
 *
 * A run only discovers its model at inference time when it executes off-platform,
 * so the proxy is the first place that can know a call resolved to a system
 * preset. This seam applies the module `beforeUsage` hook immediately before
 * the upstream request, using only server-validated context.
 *
 * Exactly one billable unit per hook dispatch:
 *   - run context  → one dispatch per proxy call (the call IS the unit).
 *   - chat context → zero dispatches; first-party chat already gated the turn
 *     at admission, and the signed loopback identity validated here proves
 *     this call is that same turn.
 */

import type { ResolvedModel } from "./org-models.ts";
import { getRunningRunCountForOrg } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { ApiError } from "../lib/errors.ts";

export type SystemProxyUsageContext =
  | {
      context: "run";
      packageId: string;
      /**
       * Where the referenced run's compute lives. ATTRIBUTION DATA ONLY: it is
       * reported onward as the hook's `executionPlane` fact and is never read
       * as a gating input. This field previously formed half of an
       * "already admitted at preflight" skip condition; that short-circuit was
       * removed (see the comment on the dispatch below) and must not come back.
       */
      runOrigin: "platform" | "remote";
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

  // Every run-context call reaching THIS seam is gated, whatever the run's
  // origin. There is no "already admitted" short-circuit, because the unit the
  // preflight gate admitted is not the unit being admitted here:
  //
  //   - `run-preflight-gates.ts` admits a run LAUNCH once, for a
  //     platform-origin run resolving a system model. That run's inference
  //     then flows through the sidecar (`MODEL_BASE_URL`), which never touches
  //     `/api/llm-proxy`.
  //   - This seam admits ONE raw proxy call, a distinct billable unit that
  //     mints its own `llm_usage` row (`source='proxy'`). It is never the
  //     continuation of the launch the preflight gate admitted.
  //
  // Skipping the hook when the referenced run was platform-origin AND declared
  // a system credential (`runs.model_source`) — as this used to — was therefore
  // not "avoiding a double gate", it was an open bypass: a preflight quote is
  // issued ONCE per run launch while the number of proxy calls attachable to
  // that run id is unbounded, and once platform compute is billed the org's
  // balance moves DURING the run, so admitting at launch gates later calls
  // against a stale balance. An org past its quota (so every new run/turn is
  // rejected)
  // could keep spending indefinitely by stamping `X-Run-Id` of ANY still-alive
  // platform system run onto its proxy calls. `assertRunAttributable` only
  // binds an API-key principal to org + application, so any key in the app can
  // borrow any live run as a billing context.
  //
  // The one-gate-per-unit invariant is preserved on the legitimate paths:
  // chat returns above (its turn was gated by `checkUsageAllowed` before the
  // loopback token was minted, and that turn IS this one call), and a run
  // launch is gated exactly once by the preflight gate.
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
