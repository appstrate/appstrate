// SPDX-License-Identifier: Apache-2.0

/**
 * Admission gate for calls that enter through `/api/llm-proxy` — platform-paid
 * and BYOK alike.
 *
 * A run only discovers its model at inference time when it executes off-platform,
 * so the proxy is the first place that can know which credential a call resolved
 * to. This seam applies the module `beforeUsage` hook immediately before the
 * upstream request, using only server-validated context.
 *
 * The platform does NOT pre-classify a call as free. Whose credential the
 * resolved preset spends is reported as the `credentialSource` fact
 * (`"system"` for a platform-supplied preset, `"org"` for one the organization
 * configured with its own credential) and the metering module decides. A module
 * that meters only platform-supplied inference quotes a BYOK call at zero and
 * admits it — same outcome as the old `isSystemModel` early return, decided in
 * the right place; a module that gates on subscription status can refuse it,
 * which the old early return made impossible.
 *
 * Exactly one billable unit per hook dispatch:
 *   - run context  → one dispatch per proxy call (the call IS the unit).
 *   - chat context → zero dispatches; first-party chat already gated the turn
 *     at admission, and the signed loopback identity validated here proves
 *     this call is that same turn.
 *   - no context   → a platform-supplied call is REFUSED (400
 *     `usage_context_required`); a BYOK call is allowed through undispatched
 *     (see the deliberate gap documented below).
 */

import type { ResolvedModel } from "./org-models.ts";
import { getRunningRunCountForOrg } from "./state/runs.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { ApiError } from "../lib/errors.ts";

type SystemProxyUsageContext =
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
  // OSS deployments may intentionally expose system presets without a metering
  // module. No hook → nothing to admit and no context requirement to enforce
  // (the 400 below exists to protect the quota gates a module provides).
  if (!hasHook("beforeUsage")) return;

  // Whose credential this call spends. A FACT reported onward, never a filter:
  // a BYOK call is dispatched too, and it is the module that decides whether it
  // costs anything.
  const credentialSource = args.resolved.isSystemModel ? ("system" as const) : ("org" as const);

  if (!args.usageContext) {
    // A platform-paid raw proxy call must belong to a validated product surface:
    // X-Run-Id for an agent, or the signed first-party loopback identity for
    // chat. Refusing an unattributed system call prevents a headless API key
    // from bypassing the run/chat quota gates.
    if (credentialSource === "system") {
      throw new ApiError({
        status: 400,
        code: "usage_context_required",
        title: "Usage Context Required",
        detail:
          "Platform-provided model calls must include a valid X-Run-Id or originate from the first-party chat loopback.",
      });
    }
    // KNOWN, DELIBERATE GAP — a contextless BYOK call dispatches nothing.
    // `BeforeUsageParams` cannot be built without a context (the `run` member
    // requires `packageId`, the `chat` member a session surface), so there is
    // no shape to report here. Requiring a context for BYOK instead would turn
    // headless BYOK API-key usage — an explicitly supported, self-funded
    // pattern — into a 400, which is a worse failure than not metering a call
    // the platform funds no inference for. Closing the gap needs a contract
    // change (a context-less usage surface), not a filter added here.
    return;
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
  //   - `run-preflight-gates.ts` admits a run LAUNCH once (every run, whatever
  //     its credential source or execution plane). A platform-origin run's
  //     inference then flows through the sidecar (`MODEL_BASE_URL`), which
  //     never touches `/api/llm-proxy`.
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
    // Derived from the preset THIS call resolved to, never from the credential
    // the referenced RUN declared (`runs.model_source` is not read here): a run
    // admitted as BYOK can still route a system-preset call through this seam,
    // and vice versa. The fact describes the call being admitted.
    credentialSource,
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
