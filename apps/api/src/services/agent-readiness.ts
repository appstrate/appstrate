// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized agent readiness validation — ensures an agent is properly configured
 * before a run. Called from all run paths (manual, scheduled).
 */

import type { LoadedPackage } from "../types/index.ts";
import {
  missingIntegrationConnection,
  resolveConnectionsForRun,
  translateResolutionError,
  type LaunchOverrides,
} from "./integration-connection-resolver.ts";
import { listActiveIntegrationIds } from "./integration-connections.ts";
import {
  fetchIntegrationManifest,
  type IntegrationManifestCache,
  type IntegrationManifestLoadFailure,
} from "./integration-service.ts";
import { resolveDeclaredSkills } from "./package-catalog.ts";
import { isPromptEmpty } from "@appstrate/core/validation";
import type {
  ConnectionResolutionError,
  ConnectionResolutionWarning,
} from "@appstrate/core/integration";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { ApiError, type ResolutionFieldError, type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import type { ConnectOfferPolicy } from "../lib/connect-offer-policy.ts";
import { attachConnectOffers } from "./connect/preflight-connect-offer.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";

interface AgentReadinessParams {
  agent: LoadedPackage;
  orgId: string;
  spaceId: string;
  /**
   * Actor whose integration connections we validate. Run kickoff paths
   * pass an actor so missing or under-scoped connections produce a 409
   * before the run is created. `null` skips integration gating — callers
   * that resolve the actor from request context may not have one.
   */
  actor: Actor | null;
  /** Layer 3 picks, so readiness honours a disambiguation instead of re-firing must_choose. */
  launchOverrides?: LaunchOverrides | null;
  /**
   * Per-call-graph memo for integration manifest fetches. The run kickoff
   * path threads one Map so this readiness pass, the resolver snapshot pass,
   * and the spawn resolver dedupe the SELECT + Zod parse per integration.
   */
  manifestCache?: IntegrationManifestCache;
  /**
   * Opt-in relay for the run-kickoff connect link (#1207) — see
   * `RUN_CONNECT_OFFERS_HEADER` (`@appstrate/core/run-and-wait-client`).
   *
   * Read by the THROWING wrapper only: `collectAgentReadiness` ignores it, so
   * the dry-run validator (the accumulate branch of `inline-run-preflight.ts`)
   * stays link-free by passing none — not by anything this function does.
   */
  connectOffers?: ConnectOfferPolicy | null;
}

/**
 * Map an {@link IntegrationManifestLoadFailure} to a structured readiness
 * error. The `integrations.` field prefix routes it into the 409 envelope
 * in `validateAgentReadiness` (request runs) and into `failSchedule`
 * (scheduled runs), so a declared-but-unspawnable integration produces a
 * visible failed run instead of a silent success (#737).
 */
function manifestFailureError(
  integrationId: string,
  failure: IntegrationManifestLoadFailure,
): ValidationFieldError {
  const field = `integrations.${integrationId}`;
  switch (failure.kind) {
    case "not_found":
      return {
        field,
        code: "integration_not_found",
        title: "Integration Not Found",
        message: `Integration '${integrationId}' is declared by the agent but no such package exists.`,
      };
    case "not_integration":
      return {
        field,
        code: "integration_wrong_type",
        title: "Invalid Integration",
        message: `Package '${integrationId}' is declared as an integration but is a '${failure.actualType}'.`,
      };
    case "invalid_manifest":
      return {
        field,
        code: "integration_invalid_manifest",
        title: "Invalid Integration Manifest",
        // The schema issues are APPENDED, not summarised away. This message is
        // server-authored prose the SPA renders verbatim (the row header in
        // `missing-connections-modal.tsx`), so it is the only place a user ever
        // sees WHICH manifest field is wrong; bare, it names a verdict and no
        // fact (see `IntegrationManifestLoadFailure.invalid_manifest`).
        message: `Integration '${integrationId}' has an invalid manifest and cannot be loaded: ${failure.issues}`,
      };
  }
}

/**
 * Collect every readiness error as structured field entries (non-throwing), and the
 * non-blocking `integration_unbound` warnings. Resolver items also come back as produced
 * (`source`, which the wire drops, and the actor's full detail).
 *
 * Single source of truth for readiness checks — the throwing wrapper
 * `validateAgentReadiness` delegates to this. Fail-fast sequence:
 * prompt → skills → integration activation → integration connections.
 */
export async function collectAgentReadiness(params: AgentReadinessParams): Promise<{
  errors: ValidationFieldError[];
  resolutionErrors: ConnectionResolutionError[];
  warnings: ResolutionFieldError[];
  resolutionWarnings: ConnectionResolutionWarning[];
}> {
  const { agent, orgId, spaceId, actor, launchOverrides } = params;
  const { manifest } = agent;
  const errors: ValidationFieldError[] = [];
  const resolutionErrors: ConnectionResolutionError[] = [];
  const resolutionWarnings: ConnectionResolutionWarning[] = [];

  if (isPromptEmpty(agent.prompt)) {
    errors.push({
      field: "prompt",
      code: "empty_prompt",
      title: "Empty Prompt",
      message: "Agent prompt is empty",
    });
  }

  // Projected from the manifest this call is about — a draft or a published
  // snapshot — never off the package object, so the declared skills and the
  // resolved closure always describe the same definition (#878). The catalog
  // query is skipped entirely when no skill is declared.
  //
  // Judged against what the DECLARING agent can reach — its home space, or
  // this space when it has none (`resolveDeclaredSkills`, RBAC spec §6.9).
  // ACTIVATION is deliberately not the question: a declared skill is carried
  // into the bundle by the agent that declares it, not offered by the launching
  // space, so a skill switched off here still runs. PLACEMENT is, and it is the
  // gate that matters — this loop is what stops the run, and `RunPackageCatalog`
  // downstream resolves the closure on `org_id` alone, so a skill reported
  // resolved here has its bytes assembled into the bundle with nothing else
  // asking.
  //
  // The message does NOT distinguish "not published" from "published somewhere
  // you cannot reach": naming the difference would make this an existence
  // oracle over every package the organization owns, which is the same reason
  // an unreachable id is a 404 and not a 403 on the package routes.
  const declaredSkills = await resolveDeclaredSkills(manifest, orgId, {
    packageId: agent.id,
    spaceId,
  });
  for (const skill of declaredSkills) {
    if (skill.resolved) continue;
    errors.push({
      field: `dependencies.skills.${skill.id}`,
      code: "missing_skill",
      title: "Missing Skill",
      message: `Required skill '${skill.id}' is not available to this agent — publish it, or share it with the agent's home space`,
    });
  }

  // Integration ACTIVATION gate — runs regardless of actor (it is a
  // space-level fact, not an actor-level one). Every integration the agent
  // declares MUST be active in the space. Without this the run silently
  // degrades: the runtime spawn resolver skips an inactive integration
  // (`isIntegrationActive` false) and the agent launches without its tools.
  // The connection resolver below does NOT catch this — it gates on whether an
  // accessible connection exists, and an inactive integration can still have
  // lingering connections that resolve cleanly.
  // Checked before connections so an inactive integration fails fast with a
  // clear cause rather than a downstream `not_connected`.
  // Batched: one SELECT over `space_packages` for every declared
  // integration instead of N serial single-row queries (run-kickoff hot path).
  const declaredIntegrations = parseManifestIntegrations(manifest as Record<string, unknown>);
  // Integrations this gate has already refused, and which the connection
  // resolution below must therefore not look at a second time — see the
  // `skipIntegrationIds` note on `resolveConnectionsForRun`.
  const refusedIntegrations = new Set<string>();
  if (declaredIntegrations.length > 0) {
    // Integration manifest-health gate (#737) — mirrors the manifest drop
    // conditions in `resolveOne` (integration-spawn-resolver.ts): a declared
    // integration whose package is missing (`not_found`), is the wrong type
    // (`not_integration`), or fails manifest validation (`invalid_manifest`)
    // is silently skipped at spawn, so the agent launches without its tools
    // yet the run finishes `success`. The connection resolver below
    // deliberately ignores these (`buildRequirement` returns null and defers
    // to this check), so readiness is the single place that surfaces them.
    // Runs regardless of actor — manifest validity is a package-level fact.
    // Fetched through the shared `manifestCache` so the connection-resolution
    // and spawn passes reuse the same SELECT + Zod parse within this run.
    const manifestResults = await Promise.all(
      declaredIntegrations.map(async (entry) => ({
        id: entry.id,
        result: await fetchIntegrationManifest(entry.id, params.manifestCache),
      })),
    );
    const manifestUnhealthy = new Set<string>();
    for (const { id, result } of manifestResults) {
      if (result.ok) continue;
      manifestUnhealthy.add(id);
      errors.push(manifestFailureError(id, result.failure));
    }

    // ACTIVATION gate — every declared integration MUST be active in the
    // space. Without this the run silently degrades: the runtime spawn
    // resolver skips an inactive integration (`isIntegrationActive` false) and
    // the agent launches without its tools. The connection resolver below does
    // NOT catch this — it gates on whether an accessible connection exists, and
    // an inactive integration can still have lingering connections that resolve
    // cleanly. Checked before connections so an
    // inactive integration fails fast with a clear cause rather than a
    // downstream `not_connected`. Integrations already flagged for a manifest
    // failure are skipped here — a missing package is necessarily inactive too,
    // and the manifest error is the more precise cause (no double-report).
    //
    // "Fails fast rather than a downstream `not_connected`" is enforced, not
    // merely ordered: each id flagged here is added to `refusedIntegrations`,
    // which the resolution below excludes. The resolver applies no active
    // filter of its own, so without that the same integration produced BOTH
    // errors — and, for a caller opted into the connect-offer relay, a live
    // connect link for an integration nobody can use in this space.
    const activeIds = await listActiveIntegrationIds(
      declaredIntegrations.map((entry) => entry.id),
      spaceId,
    );
    for (const entry of declaredIntegrations) {
      if (manifestUnhealthy.has(entry.id)) continue;
      if (!activeIds.has(entry.id)) {
        refusedIntegrations.add(entry.id);
        errors.push({
          field: `integrations.${entry.id}`,
          code: "integration_not_active",
          title: "Integration Not Active",
          message: `Integration '${entry.id}' is not active in this space.`,
        });
      }
    }
  }

  // Resolver enumerates own + shared connections, applies the cascade, and surfaces
  // structured errors per (integration, authKey). Skipped when the caller
  // has no actor context (integration gating only applies to run kickoff).
  //
  // run-pipeline.ts re-runs the resolver after readiness
  // (with the same overrides) to produce the persisted snapshot. The two
  // passes cannot disagree even though only this one passes
  // `skipIntegrationIds`: a non-empty set means an error was pushed above, and
  // the throwing wrapper raises it, so the snapshot pass never runs on an
  // agent whose integrations this pass refused. When the set IS empty the two
  // calls are identical.
  if (actor) {
    const resolution = await resolveConnectionsForRun({
      agentManifest: manifest as Record<string, unknown>,
      packageId: agent.id,
      actor,
      scope: { orgId, spaceId },
      ...(launchOverrides ? { launchOverrides } : {}),
      ...(params.manifestCache ? { manifestCache: params.manifestCache } : {}),
      ...(refusedIntegrations.size > 0 ? { skipIntegrationIds: refusedIntegrations } : {}),
    });
    for (const e of resolution.errors) {
      errors.push(translateResolutionError(e));
    }
    resolutionErrors.push(...resolution.errors);
    resolutionWarnings.push(...resolution.warnings);
  }

  return {
    errors,
    resolutionErrors,
    warnings: resolutionWarnings.map(translateResolutionError),
    resolutionWarnings,
  };
}

/**
 * Validate that an agent is ready for a run. Delegates to
 * `collectAgentReadiness` and throws the first error, preserving the
 * historical fail-fast contract (single ApiError with the original code and
 * human-readable title carried on the field entry). On success returns the
 * launch response's `warnings`, connect links attached under the same opt-in
 * as the 409's.
 */
export async function validateAgentReadiness(
  params: AgentReadinessParams,
): Promise<ResolutionFieldError[]> {
  const { errors, warnings } = await collectAgentReadiness(params);
  if (errors.length === 0) return withConnectOffers(params, warnings);

  // Integration errors get their own 409 envelope with every integration
  // failure populated on `errors[]` so the dashboard's MissingConnections
  // modal can render the full list in one round trip.
  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));
  if (integrationErrors.length > 0) {
    // Fire-and-forget — modules opting in (e.g. webhooks) get a structured
    // notification before we throw. Integration errors only accumulate when
    // an actor was present, so the guard narrows the type for the payload.
    if (params.actor) {
      void emitEvent("onRunConnectionMissing", {
        orgId: params.orgId,
        spaceId: params.spaceId,
        packageId: params.agent.id,
        actor: { type: params.actor.type, id: params.actor.id },
        errors: integrationErrors.map((e) => ({
          field: e.field,
          code: e.code,
          message: e.message,
          ...(e.title ? { title: e.title } : {}),
        })),
      });
    }
    // Mint the connect links LAST — strictly after the webhook projection
    // above, which must never carry a bearer capability off-platform.
    throw missingIntegrationConnection(await withConnectOffers(params, integrationErrors));
  }

  const first = errors[0]!;
  throw new ApiError({
    status: 400,
    code: first.code,
    title: first.title ?? first.code,
    detail: first.message,
  });
}

/** Connect links on `items`, only for a caller that opted in and holds `integrations:connect`. */
async function withConnectOffers(
  params: AgentReadinessParams,
  items: ResolutionFieldError[],
): Promise<ResolutionFieldError[]> {
  if (!params.connectOffers || !params.actor || items.length === 0) return items;
  return attachConnectOffers({
    errors: items,
    scope: { orgId: params.orgId, spaceId: params.spaceId },
    actor: params.actor,
    policy: params.connectOffers,
    ...(params.manifestCache ? { manifestCache: params.manifestCache } : {}),
  });
}
