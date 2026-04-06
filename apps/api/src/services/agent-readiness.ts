// SPDX-License-Identifier: Apache-2.0

/**
 * Centralized agent readiness validation — ensures an agent is properly configured
 * before a run. Called from all run paths (manual, scheduled).
 */

import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import { validateAgentDependencies } from "./dependency-validation.ts";
import { validateConfig } from "./schema.ts";
import { resolveManifestProviders, extractManifestSchemas } from "../lib/manifest-utils.ts";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/core/validation";
import { ApiError } from "../lib/errors.ts";

/**
 * Validate that an agent is ready for a run.
 * Checks are ordered cheapest-first, fail-fast on first error.
 *
 * 1. Empty prompt
 * 2. Missing required skills
 * 3. Missing required tools
 * 4. Provider dependencies (delegates to validateAgentDependencies)
 * 5. Config validation (if config provided)
 *
 * Throws ApiError on first validation failure.
 */
export async function validateAgentReadiness(params: {
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  config?: Record<string, unknown>;
  applicationId: string;
}): Promise<void> {
  const { agent, providerProfiles, orgId, config, applicationId } = params;
  const { manifest } = agent;

  // 1. Empty prompt
  if (isPromptEmpty(agent.prompt)) {
    throw new ApiError({
      status: 400,
      code: "empty_prompt",
      title: "Empty Prompt",
      detail: "Agent prompt is empty",
    });
  }

  // 2. Missing skills
  const missingSkills = findMissingDependencies(
    manifest.dependencies?.skills ?? {},
    agent.skills.map((s) => s.id),
  );
  if (missingSkills.length > 0) {
    throw new ApiError({
      status: 400,
      code: "missing_skill",
      title: "Missing Skill",
      detail: `Required skill '${missingSkills[0]}' is not installed`,
    });
  }

  // 3. Missing tools
  const missingTools = findMissingDependencies(
    (manifest.dependencies?.tools ?? {}) as Record<string, string>,
    agent.tools.map((e) => e.id),
  );
  if (missingTools.length > 0) {
    throw new ApiError({
      status: 400,
      code: "missing_tool",
      title: "Missing Tool",
      detail: `Required tool '${missingTools[0]}' is not installed`,
    });
  }

  // 4. Provider dependencies
  const manifestProviders = resolveManifestProviders(manifest);
  await validateAgentDependencies(manifestProviders, providerProfiles, orgId, applicationId);

  // 5. Config validation
  if (config) {
    const { config: configSchema } = extractManifestSchemas(manifest);
    const effectiveSchema = configSchema ?? { type: "object" as const, properties: {} };
    const configValidation = validateConfig(config, effectiveSchema);
    if (!configValidation.valid) {
      const first = configValidation.errors[0]!;
      throw new ApiError({
        status: 400,
        code: "config_incomplete",
        title: "Config Incomplete",
        detail: `Parameter '${first.field}' is required`,
      });
    }
  }
}
