// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized agent readiness validation — ensures an agent is properly configured
 * before a run. Called from all run paths (manual, scheduled).
 */

import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { collectDependencyErrors } from "./dependency-validation.ts";
import { validateConfig } from "./schema.ts";
import { resolveManifestProviders, extractManifestSchemas } from "../lib/manifest-utils.ts";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { deepMergeConfig } from "@appstrate/core/schema-validation";
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";
import { resolveProviderProfiles } from "./connection-profiles.ts";
import type {
  ReadinessProviderEntry,
  ReadinessReason,
  ReadinessReport,
} from "@appstrate/shared-types";

export type { ReadinessProviderEntry, ReadinessReason, ReadinessReport };

export interface AgentReadinessParams {
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  config?: Record<string, unknown>;
  applicationId: string;
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
 * `validateAgentReadiness` delegates to this. Order matches the historical
 * fail-fast sequence: prompt → skills → tools → provider deps → config.
 */
export async function collectAgentReadinessErrors(
  params: AgentReadinessParams,
): Promise<ValidationFieldError[]> {
  const { agent, providerProfiles, orgId, config, applicationId, skip } = params;
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

  const missingTools = findMissingDependencies(
    (manifest.dependencies?.tools ?? {}) as Record<string, string>,
    agent.tools.map((e) => e.id),
  );
  for (const toolId of missingTools) {
    errors.push({
      field: `dependencies.tools.${toolId}`,
      code: "missing_tool",
      title: "Missing Tool",
      message: `Required tool '${toolId}' is not installed`,
    });
  }

  const manifestProviders = resolveManifestProviders(manifest);
  errors.push(
    ...(await collectDependencyErrors(manifestProviders, providerProfiles, orgId, applicationId)),
  );

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

// ---------------------------------------------------------------------------
// Readiness preflight — read-only contract for the CLI (and dashboard) to
// inspect provider readiness before a run, without committing to one.
// Reuses resolveProviderProfiles + collectDependencyErrors so the answer
// stays in lockstep with what the run pipeline would actually do.
// ---------------------------------------------------------------------------

export interface ReadinessQuery {
  agent: LoadedPackage;
  applicationId: string;
  orgId: string;
  /** Default user profile id (X-Connection-Profile-Id equivalent). */
  defaultUserProfileId: string | null;
  /** Per-provider profile overrides, mirrors `--provider-profile` on the CLI. */
  perProviderOverrides?: Record<string, string>;
  /** Optional app profile id (used when the request is in app-profile mode). */
  appProfileId?: string | null;
}

/**
 * Compute the set of unsatisfied providers for an agent under the given
 * profile context. Single source of truth for both the CLI's preflight
 * call and any future dashboard inspector that wants to surface "which
 * connections do I still need?" without triggering a run.
 */
export async function resolveAgentReadiness(query: ReadinessQuery): Promise<ReadinessReport> {
  const { agent, applicationId, orgId, defaultUserProfileId, perProviderOverrides, appProfileId } =
    query;
  const manifestProviders = resolveManifestProviders(agent.manifest);
  const providerProfiles = await resolveProviderProfiles(
    manifestProviders,
    defaultUserProfileId,
    perProviderOverrides,
    appProfileId ?? null,
    applicationId,
  );
  const errors = await collectDependencyErrors(
    manifestProviders,
    providerProfiles,
    orgId,
    applicationId,
  );

  const seen = new Set<string>();
  const missing: ReadinessProviderEntry[] = [];
  for (const err of errors) {
    const providerId = err.field.startsWith("providers.")
      ? err.field.slice("providers.".length)
      : err.field;
    if (seen.has(providerId)) continue;
    seen.add(providerId);
    missing.push({
      providerId,
      profileId: providerProfiles[providerId]?.profileId ?? null,
      reason: mapReason(err.code),
      message: err.message,
    });
  }
  return { ready: missing.length === 0, missing };
}

function mapReason(code: string): ReadinessReason {
  switch (code) {
    case "needs_reconnection":
      return "needs_reconnection";
    case "scope_insufficient":
      return "scope_insufficient";
    case "provider_not_enabled":
    case "provider_not_configured":
      return "provider_not_enabled";
    default:
      return "no_connection";
  }
}
