// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized agent readiness validation — ensures an agent is properly configured
 * before a run. Called from all run paths (manual, scheduled).
 */

import type { LoadedPackage } from "../types/index.ts";
import {
  resolveConnectionsForRun,
  translateResolutionError,
} from "./integration-connection-resolver.ts";
import { listActiveIntegrationIds } from "./integration-connections.ts";
import {
  fetchIntegrationManifest,
  type IntegrationManifestCache,
  type IntegrationManifestLoadFailure,
} from "./integration-service.ts";
import { validateConfig } from "./schema.ts";
import { resolveDeclaredSkills } from "./package-catalog.ts";
import { extractManifestSchemas } from "../lib/manifest-utils.ts";
import { isPromptEmpty } from "@appstrate/core/validation";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { deepMergeConfig } from "@appstrate/core/schema-validation";
import type { ConnectionOverrides } from "@appstrate/core/integration";
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";

export interface AgentReadinessParams {
  agent: LoadedPackage;
  orgId: string;
  config?: Record<string, unknown>;
  applicationId: string;
  /**
   * Actor whose integration connections we validate. Run kickoff paths
   * pass an actor so missing or under-scoped connections produce a 412
   * before the run is created. `null` skips integration gating — callers
   * that resolve the actor from request context may not have one.
   */
  actor: Actor | null;
  /**
   * Caller's run-time connection picks (mechanism #2 of the resolver
   * cascade). Threaded into the readiness check so the must_choose-retry
   * UX loop in `MissingConnectionsModal` actually completes: without it,
   * readiness re-fires must_choose on >1 candidates even when the caller
   * already disambiguated via `connection_overrides` on the request body.
   */
  runOverrides?: ConnectionOverrides | null;
  /**
   * Schedule's frozen connection picks (mechanism #3). Plumbed for parity
   * with `run-pipeline.ts:resolveRunConnectionsOrError` — schedules apply
   * their overrides once at fire time, and readiness should honour them.
   */
  scheduleOverrides?: ConnectionOverrides | null;
  /**
   * Per-call-graph memo for integration manifest fetches. The run kickoff
   * path threads one Map so this readiness pass, the resolver snapshot pass,
   * and the spawn resolver dedupe the SELECT + Zod parse per integration.
   */
  manifestCache?: IntegrationManifestCache;
}

/**
 * Collect every readiness error as structured field entries (non-throwing).
 *
 * Single source of truth for readiness checks — the throwing wrapper
 * `validateAgentReadiness` delegates to this. Fail-fast sequence:
 * prompt → skills → integration install/enable → integration connections → config.
 */
/**
 * Map an {@link IntegrationManifestLoadFailure} to a structured readiness
 * error. The `integrations.` field prefix routes it into the 412 envelope
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
        message: `Integration '${integrationId}' has an invalid manifest and cannot be loaded.`,
      };
  }
}

export async function collectAgentReadinessErrors(
  params: AgentReadinessParams,
): Promise<ValidationFieldError[]> {
  const { agent, orgId, config, applicationId, actor, runOverrides, scheduleOverrides } = params;
  const { manifest } = agent;
  const errors: ValidationFieldError[] = [];

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
  const declaredSkills = await resolveDeclaredSkills(manifest, orgId);
  for (const skill of declaredSkills) {
    if (skill.resolved) continue;
    errors.push({
      field: `dependencies.skills.${skill.id}`,
      code: "missing_skill",
      title: "Missing Skill",
      message: `Required skill '${skill.id}' is not installed`,
    });
  }

  // Integration install/enable gate — runs regardless of actor (it is an
  // app-level fact, not an actor-level one). Every integration the agent
  // declares MUST be installed AND enabled on the application. Without this
  // the run silently degrades: the runtime spawn resolver skips an inactive
  // integration (`isIntegrationActive` false) and the agent launches without
  // its tools. The connection resolver below does NOT catch this — it gates
  // on whether an accessible connection exists, and a disabled/uninstalled
  // integration can still have lingering connections that resolve cleanly.
  // Checked before connections so an inactive integration fails fast with a
  // clear cause rather than a downstream `not_connected`.
  // Batched: one SELECT over `application_packages` for every declared
  // integration instead of N serial single-row queries (run-kickoff hot path).
  const declaredIntegrations = parseManifestIntegrations(manifest as Record<string, unknown>);
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

    // Install/enable gate — every declared integration MUST be installed AND
    // enabled on the application. Without this the run silently degrades: the
    // runtime spawn resolver skips an inactive integration (`isIntegrationActive`
    // false) and the agent launches without its tools. The connection resolver
    // below does NOT catch this — it gates on whether an accessible connection
    // exists, and a disabled/uninstalled integration can still have lingering
    // connections that resolve cleanly. Checked before connections so an
    // inactive integration fails fast with a clear cause rather than a
    // downstream `not_connected`. Integrations already flagged for a manifest
    // failure are skipped here — a missing package is necessarily inactive too,
    // and the manifest error is the more precise cause (no double-report).
    const activeIds = await listActiveIntegrationIds(
      declaredIntegrations.map((entry) => entry.id),
      applicationId,
    );
    for (const entry of declaredIntegrations) {
      if (manifestUnhealthy.has(entry.id)) continue;
      if (!activeIds.has(entry.id)) {
        errors.push({
          field: `integrations.${entry.id}`,
          code: "integration_not_active",
          title: "Integration Not Enabled",
          message: `Integration '${entry.id}' is not installed or is disabled in this application.`,
        });
      }
    }
  }

  // Resolver enumerates own + shared connections, applies
  // pin > run override > schedule override > fallback, and surfaces
  // structured errors per (integration, authKey). Skipped when the caller
  // has no actor context (integration gating only applies to run kickoff).
  //
  // `runOverrides` / `scheduleOverrides` are threaded so the must_choose
  // recovery loop in `MissingConnectionsModal` can complete: the user
  // picks a candidate, the modal POSTs `connection_overrides`, readiness
  // honours the pick instead of re-firing must_choose on the same N>1
  // candidate set. run-pipeline.ts re-runs the resolver after readiness
  // (with the same overrides) to produce the persisted snapshot — both
  // passes see the same inputs so they cannot disagree.
  if (actor) {
    const resolution = await resolveConnectionsForRun({
      agentManifest: manifest as Record<string, unknown>,
      packageId: agent.id,
      actor,
      scope: { orgId, applicationId },
      ...(runOverrides ? { runOverrides } : {}),
      ...(scheduleOverrides ? { scheduleOverrides } : {}),
      ...(params.manifestCache ? { manifestCache: params.manifestCache } : {}),
    });
    for (const e of resolution.errors) {
      errors.push(translateResolutionError(e));
    }
  }

  if (config) {
    const { config: configSchema } = extractManifestSchemas(manifest);
    const effectiveSchema = configSchema ?? { type: "object" as const, properties: {} };
    const configValidation = validateConfig(config, effectiveSchema);
    if (!configValidation.valid) {
      for (const e of configValidation.errors) {
        errors.push({
          field: e.field ? `config.${e.field}` : "config",
          code: "invalid_config",
          title: "Invalid Config",
          message: e.message,
        });
      }
    }
  }

  return errors;
}

/**
 * Validate that an agent is ready for a run. Delegates to
 * `collectAgentReadinessErrors` and throws the first error, preserving the
 * historical fail-fast contract (single ApiError with the original code and
 * human-readable title carried on the field entry).
 */
export async function validateAgentReadiness(params: AgentReadinessParams): Promise<void> {
  const errors = await collectAgentReadinessErrors(params);
  if (errors.length === 0) return;

  // Integration errors get their own 412 envelope with every integration
  // failure populated on `errors[]` so the dashboard's MissingConnections
  // modal can render the full list in one round trip.
  const integrationErrors = errors.filter((e) => e.field.startsWith("integrations."));
  if (integrationErrors.length > 0) {
    const first = integrationErrors[0]!;
    // Fire-and-forget — modules opting in (e.g. webhooks) get a structured
    // notification before we throw. Integration errors only accumulate when
    // an actor was present, so the guard narrows the type for the payload.
    if (params.actor) {
      void emitEvent("onRunConnectionMissing", {
        orgId: params.orgId,
        applicationId: params.applicationId,
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
    throw new ApiError({
      status: 412,
      code: "missing_integration_connection",
      title: "Missing Integration Connection",
      detail: first.message,
      errors: integrationErrors,
    });
  }

  const first = errors[0]!;
  throw new ApiError({
    status: 400,
    code: first.code,
    title: first.title ?? first.code,
    detail: first.message,
  });
}

/**
 * Re-validate a deep-merged config against the manifest schema.
 *
 * `resolveRunPreflight` validates the *persisted* `application_packages.config`
 * once at preflight time. When a caller supplies a per-run `config` override
 * on `POST /run` (or freezes one on a schedule), the merged result has not
 * been vetted — the override could push the config out of schema. This
 * function closes that gap on every merge.
 *
 * Throws `ApiError(400, "invalid_config")` on the first violation, mirroring
 * the contract of `validateAgentReadiness` so existing error mapping handles
 * it without special cases. No-op when the manifest declares no config schema.
 */
function validateMergedConfigOrThrow(agent: LoadedPackage, config: Record<string, unknown>): void {
  const { config: configSchema } = extractManifestSchemas(agent.manifest);
  if (!configSchema) return;
  const result = validateConfig(config, configSchema);
  if (result.valid) return;
  const first = result.errors[0]!;
  throw new ApiError({
    status: 400,
    code: "invalid_config",
    title: "Invalid Config",
    detail: first.field ? `config.${first.field}: ${first.message}` : first.message,
  });
}

/**
 * Apply a per-run config override on top of the persisted config and re-validate
 * against the manifest schema. No-op when `override` is null/undefined — returns
 * `persisted` verbatim. Throws `ApiError(400, "invalid_config")` if the merged
 * result violates the manifest schema (via `validateMergedConfigOrThrow`).
 *
 * Single source of truth for the merge+validate sequence shared by `POST /run`
 * and the scheduler — every per-run invocation reaches an identical resolved
 * config for the same `(persisted, override)` pair.
 */
export function mergeAndValidateConfigOverride(
  agent: LoadedPackage,
  persisted: Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!override) return persisted;
  const merged = deepMergeConfig(persisted, override);
  validateMergedConfigOrThrow(agent, merged);
  return merged;
}
