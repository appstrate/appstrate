/**
 * Centralized flow readiness validation — ensures a flow is properly configured
 * before execution. Called from all execution paths (manual, scheduled, share link).
 */

import type { LoadedFlow } from "../types/index.ts";
import { validateFlowDependencies } from "./dependency-validation.ts";
import type { DependencyError } from "./dependency-validation.ts";
import { validateConfig } from "./schema.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { isPromptEmpty, findMissingDependencies } from "../lib/flow-readiness.ts";

export interface ReadinessError {
  error: string;
  message: string;
  providerId?: string;
  connectUrl?: string;
  configUrl?: string;
  details?: Record<string, unknown>;
}

/**
 * Validate that a flow is ready for execution.
 * Checks are ordered cheapest-first, fail-fast on first error.
 *
 * 1. Empty prompt
 * 2. Missing required skills
 * 3. Missing required tools
 * 4. Provider dependencies (delegates to validateFlowDependencies)
 * 5. Config validation (if config provided)
 */
export async function validateFlowReadiness(params: {
  flow: LoadedFlow;
  providerProfiles: Record<string, string>;
  orgId: string;
  config?: Record<string, unknown>;
}): Promise<ReadinessError | null> {
  const { flow, providerProfiles, orgId, config } = params;
  const { manifest } = flow;

  // 1. Empty prompt
  if (isPromptEmpty(flow.prompt)) {
    return {
      error: "EMPTY_PROMPT",
      message: "Flow prompt is empty",
    };
  }

  // 2. Missing skills
  const missingSkills = findMissingDependencies(
    manifest.dependencies?.skills ?? {},
    flow.skills.map((s) => s.id),
  );
  if (missingSkills.length > 0) {
    return {
      error: "MISSING_SKILL",
      message: `Required skill '${missingSkills[0]}' is not installed`,
      details: { skillId: missingSkills[0] },
    };
  }

  // 3. Missing tools
  const missingTools = findMissingDependencies(
    (manifest.dependencies?.tools ?? {}) as Record<string, string>,
    flow.tools.map((e) => e.id),
  );
  if (missingTools.length > 0) {
    return {
      error: "MISSING_TOOL",
      message: `Required tool '${missingTools[0]}' is not installed`,
      details: { toolId: missingTools[0] },
    };
  }

  // 4. Provider dependencies
  const manifestProviders = resolveManifestProviders(manifest);
  const depError: DependencyError | null = await validateFlowDependencies(
    manifestProviders,
    providerProfiles,
    orgId,
  );
  if (depError) {
    return depError;
  }

  // 5. Config validation
  if (config) {
    const configSchema = manifest.config?.schema ?? {
      type: "object" as const,
      properties: {},
    };
    const configValidation = validateConfig(config, configSchema);
    if (!configValidation.valid) {
      const first = configValidation.errors[0]!;
      return {
        error: "CONFIG_INCOMPLETE",
        message: `Parameter '${first.field}' is required`,
        configUrl: `/api/flows/${flow.id}/config`,
      };
    }
  }

  return null;
}
