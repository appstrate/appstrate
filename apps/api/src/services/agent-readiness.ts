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
import { ApiError, type ValidationFieldError } from "../lib/errors.ts";

export interface AgentReadinessParams {
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  config?: Record<string, unknown>;
  applicationId: string;
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
  const { agent, providerProfiles, orgId, config, applicationId } = params;
  const { manifest } = agent;
  const errors: ValidationFieldError[] = [];

  if (isPromptEmpty(agent.prompt)) {
    errors.push({
      field: "prompt",
      code: "empty_prompt",
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
      message: `Required tool '${toolId}' is not installed`,
    });
  }

  const manifestProviders = resolveManifestProviders(manifest);
  errors.push(
    ...(await collectDependencyErrors(manifestProviders, providerProfiles, orgId, applicationId)),
  );

  if (config) {
    const { config: configSchema } = extractManifestSchemas(manifest);
    const effectiveSchema = configSchema ?? { type: "object" as const, properties: {} };
    const configValidation = validateConfig(config, effectiveSchema);
    if (!configValidation.valid) {
      for (const e of configValidation.errors) {
        errors.push({
          field: e.field ? `config.${e.field}` : "config",
          code: "config_incomplete",
          message: e.message,
        });
      }
    }
  }

  return errors;
}

const CODE_TITLES: Record<string, string> = {
  empty_prompt: "Empty Prompt",
  missing_skill: "Missing Skill",
  missing_tool: "Missing Tool",
  provider_not_enabled: "Provider Not Enabled",
  provider_not_configured: "Provider Not Configured",
  needs_reconnection: "Needs Reconnection",
  scope_insufficient: "Scope Insufficient",
  dependency_not_satisfied: "Dependency Not Satisfied",
  config_incomplete: "Config Incomplete",
};

/**
 * Validate that an agent is ready for a run. Delegates to
 * `collectAgentReadinessErrors` and throws the first error, preserving the
 * historical fail-fast contract (single ApiError with the original code).
 */
export async function validateAgentReadiness(params: AgentReadinessParams): Promise<void> {
  const errors = await collectAgentReadinessErrors(params);
  if (errors.length === 0) return;
  const first = errors[0]!;
  throw new ApiError({
    status: 400,
    code: first.code,
    title: CODE_TITLES[first.code] ?? "Validation Failed",
    detail: first.message,
  });
}
