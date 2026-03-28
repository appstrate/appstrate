/**
 * Centralized flow readiness validation — ensures a flow is properly configured
 * before execution. Called from all execution paths (manual, scheduled).
 */

import type { LoadedPackage } from "../types/index.ts";
import { validateFlowDependencies } from "./dependency-validation.ts";
import { validateConfig } from "./schema.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { isPromptEmpty, findMissingDependencies } from "@appstrate/shared-types";
import { ApiError } from "../lib/errors.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";

/**
 * Validate that a flow is ready for execution.
 * Checks are ordered cheapest-first, fail-fast on first error.
 *
 * 1. Empty prompt
 * 2. Missing required skills
 * 3. Missing required tools
 * 4. Provider dependencies (delegates to validateFlowDependencies)
 * 5. Config validation (if config provided)
 *
 * Throws ApiError on first validation failure.
 */
export async function validateFlowReadiness(params: {
  flow: LoadedPackage;
  providerProfiles: Record<string, string>;
  orgId: string;
  config?: Record<string, unknown>;
}): Promise<void> {
  const { flow, providerProfiles, orgId, config } = params;
  const { manifest } = flow;

  // 1. Empty prompt
  if (isPromptEmpty(flow.prompt)) {
    throw new ApiError({
      status: 400,
      code: "empty_prompt",
      title: "Empty Prompt",
      detail: "Flow prompt is empty",
    });
  }

  // 2. Missing skills
  const missingSkills = findMissingDependencies(
    manifest.dependencies?.skills ?? {},
    flow.skills.map((s) => s.id),
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
    flow.tools.map((e) => e.id),
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
  await validateFlowDependencies(manifestProviders, providerProfiles, orgId);

  // 5. Config validation
  if (config) {
    const configSchema = manifest.config?.schema ?? {
      type: "object" as const,
      properties: {},
    };
    const configValidation = validateConfig(config, asJSONSchemaObject(configSchema));
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
