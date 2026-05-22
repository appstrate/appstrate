// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized agent readiness validation — ensures an agent is properly configured
 * before a run. Called from all run paths (manual, scheduled).
 */

import type { LoadedPackage } from "../types/index.ts";
import { resolveConnectionsForRun } from "./integration-connection-resolver.ts";
import type { ConnectionResolutionError } from "@appstrate/core/integration";
import { validateConfig } from "./schema.ts";
import { extractManifestSchemas } from "../lib/manifest-utils.ts";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { deepMergeConfig } from "@appstrate/core/schema-validation";
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";
import type { Actor } from "../lib/actor.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";

export interface AgentReadinessParams {
  agent: LoadedPackage;
  orgId: string;
  config?: Record<string, unknown>;
  applicationId: string;
  /**
   * Actor whose integration connections we validate. When `null`/omitted,
   * integration gating is skipped (preserves legacy callers that didn't
   * own an actor context — e.g. pure provider readiness probes). Run
   * kickoff paths must pass an actor so missing or under-scoped
   * connections produce a 412 before the run is created.
   */
  actor?: Actor | null;
  /**
   * Skip individual checks already performed by an upstream validator. Used
   * by the inline-run preflight, which validates `prompt` via the manifest
   * structural check and `config` via AJV at its own stage, then calls
   * readiness for the remaining dependency checks. Avoids emitting duplicate
   * entries for the same field in `accumulate` mode.
   */
  skip?: { prompt?: boolean; config?: boolean };
}

/**
 * Collect every readiness error as structured field entries (non-throwing).
 *
 * Single source of truth for readiness checks — the throwing wrapper
 * `validateAgentReadiness` delegates to this. Fail-fast sequence:
 * prompt → skills → integration connections → config.
 */
export async function collectAgentReadinessErrors(
  params: AgentReadinessParams,
): Promise<ValidationFieldError[]> {
  const { agent, orgId, config, applicationId, actor, skip } = params;
  const { manifest } = agent;
  const errors: ValidationFieldError[] = [];

  if (!skip?.prompt && isPromptEmpty(agent.prompt)) {
    errors.push({
      field: "prompt",
      code: "empty_prompt",
      title: "Empty Prompt",
      message: "Agent prompt is empty",
    });
  }

  const missingSkills = findMissingDependencies(
    manifest.dependencies?.skills ?? {},
    agent.skills.map((s) => s.id),
  );
  for (const skillId of missingSkills) {
    errors.push({
      field: `dependencies.skills.${skillId}`,
      code: "missing_skill",
      title: "Missing Skill",
      message: `Required skill '${skillId}' is not installed`,
    });
  }

  if (actor) {
    // New flat-connections + pins model (replaces the per-actor-only
    // lookup). Resolver enumerates own + shared connections, applies
    // pin > run override > schedule override > fallback, and surfaces
    // structured errors per (integration, authKey).
    const resolution = await resolveConnectionsForRun({
      agentManifest: manifest as Record<string, unknown>,
      packageId: agent.id,
      actor,
      scope: { orgId, applicationId },
      // Run/schedule overrides aren't plumbed through readiness today;
      // they are evaluated at run creation time by run-pipeline.ts so the
      // snapshot stays in sync with the actual run. Readiness only sees
      // pin + fallback, which is the conservative view (passes readiness
      // when at least one connection is accessible — wider checks happen
      // when the caller binds their override at run creation).
    });
    for (const e of resolution.errors) {
      errors.push(translateResolutionError(e));
    }
  }

  if (!skip?.config && config) {
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
    // notification before we throw. The actor is always present on
    // integration-gated paths (collection above only runs when actor is
    // non-null), so the assertion is safe.
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
 * Map a `ConnectionResolutionError` to the wire-format ValidationFieldError
 * the upstream 412 envelope expects.
 *
 * Field path: `integrations.{packageId}` — one error per integration in
 * the flat model. The dashboard's MissingConnectionsModal parses on the
 * same prefix so existing UI plumbing still works.
 */
export function translateResolutionError(e: ConnectionResolutionError): ValidationFieldError {
  const title = TITLE_BY_CODE[e.code];
  return {
    field: `integrations.${e.integrationId}`,
    code: e.code,
    title,
    message: e.message,
    // Smuggle the candidate ids on must_choose_connection so the modal
    // can render a picker.
    ...(e.candidateConnectionIds && e.candidateConnectionIds.length > 0
      ? { candidateConnectionIds: e.candidateConnectionIds }
      : {}),
    // Smuggle scope-diff detail on insufficient_scopes so the UI can offer
    // an upgrade (own connection) or a read-only error (foreign owner).
    ...(e.code === "insufficient_scopes"
      ? {
          ...(e.connectionId ? { connectionId: e.connectionId } : {}),
          ...(e.missingScopes && e.missingScopes.length > 0
            ? { missingScopes: e.missingScopes }
            : {}),
          ...(e.ownedByActor !== undefined ? { ownedByActor: e.ownedByActor } : {}),
        }
      : {}),
  } as ValidationFieldError;
}

const TITLE_BY_CODE: Record<ConnectionResolutionError["code"], string> = {
  not_connected: "Integration Not Connected",
  needs_reconnection: "Needs Reconnection",
  connection_blocked_by_admin: "Connection Blocked by Admin",
  pinned_connection_unavailable: "Pinned Connection Unavailable",
  override_connection_unavailable: "Override Connection Unavailable",
  must_choose_connection: "Multiple Connections Available — Pick One",
  insufficient_scopes: "Insufficient Permissions",
};

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
export function validateMergedConfigOrThrow(
  agent: LoadedPackage,
  config: Record<string, unknown>,
): void {
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
 * result violates the manifest schema (mirrors `validateMergedConfigOrThrow`).
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
