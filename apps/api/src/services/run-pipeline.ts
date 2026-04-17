// SPDX-License-Identifier: Apache-2.0

/**
 * Shared run pipeline — the common tail of "build context → pre-run hooks → create run → execute".
 * Used by both the POST /run route and the scheduler's triggerScheduledRun.
 */

import { logger } from "../lib/logger.ts";
import { buildRunContext, ModelNotConfiguredError } from "./env-builder.ts";
import { callHook, hasHook } from "../lib/modules/module-loader.ts";
import { createRun, getRunningRunCountForOrg } from "./state/index.ts";
import { getPackageConfig } from "./application-packages.ts";
import { executeAgentInBackground } from "../routes/runs.ts";
import { resolveProviderProfiles } from "./connection-profiles.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { resolveProviderStatuses } from "./connection-manager/index.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { parseScopedName } from "@appstrate/core/naming";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { UploadedFile, FileReference } from "./adapters/types.ts";
import type { RunProviderSnapshot } from "@appstrate/shared-types";

/**
 * Extract the denormalized @scope and display-name snapshot for a loaded
 * package. Stored on `runs.agent_scope` / `runs.agent_name` so the global
 * /runs view survives rename, delete, and inline-run compaction (after
 * which the manifest is NULLed).
 */
export function extractRunAgentDenorm(pkg: LoadedPackage): {
  scope: string | null;
  name: string | null;
} {
  const parsed = parseScopedName(pkg.id);
  const manifestName =
    typeof pkg.manifest.displayName === "string"
      ? pkg.manifest.displayName
      : typeof pkg.manifest.name === "string"
        ? pkg.manifest.name
        : null;
  return {
    scope: parsed?.scope ?? null,
    name: manifestName,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunPipelineParams {
  runId: string;
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  orgId: string;
  actor: Actor | null;
  input?: Record<string, unknown> | null;
  files?: FileReference[];
  config: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionLabel?: string;
  /** Schedule ID — set only for scheduled runs. */
  scheduleId?: string;
  /** Connection profile ID used to create the run. */
  connectionProfileId?: string;
  /** Application ID — required for all runs. */
  applicationId: string;
  /** Uploaded files to inject into the container. */
  uploadedFiles?: UploadedFile[];
  /** API key ID that triggered the run (if auth via API key). */
  apiKeyId?: string;
}

/**
 * Known codes: "model_not_configured", "unexpected", plus module-provided codes (via RunRejection).
 */
export type RunPipelineError = { code: string; message: string; status?: number };

export type RunPipelineResult =
  | { ok: true; runId: string; modelSource: string | null }
  | { ok: false; error: RunPipelineError };

// ---------------------------------------------------------------------------
// Preflight — shared by run route and scheduler
// ---------------------------------------------------------------------------

export interface PreflightResult {
  providerProfiles: ProviderProfileMap;
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
}

/**
 * Resolve provider profiles, package config, and validate agent readiness.
 * Shared by the POST /run route and the scheduler's triggerScheduledRun.
 */
export async function resolveRunPreflight(params: {
  agent: LoadedPackage;
  applicationId: string;
  orgId: string;
  defaultUserProfileId: string | null;
  userProviderOverrides?: Record<string, string>;
  appProfileId: string | null;
}): Promise<PreflightResult> {
  const { agent, applicationId, orgId, defaultUserProfileId, userProviderOverrides, appProfileId } =
    params;

  const manifestProviders = resolveManifestProviders(agent.manifest);

  const [providerProfiles, packageConfig] = await Promise.all([
    resolveProviderProfiles(
      manifestProviders,
      defaultUserProfileId,
      userProviderOverrides,
      appProfileId,
      applicationId,
    ),
    getPackageConfig(applicationId, agent.id),
  ]);

  await validateAgentReadiness({
    agent,
    providerProfiles,
    orgId,
    config: packageConfig.config,
    applicationId,
  });

  return {
    providerProfiles,
    config: packageConfig.config,
    modelId: packageConfig.modelId,
    proxyId: packageConfig.proxyId,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Build run context, run module pre-checks, create run record, and fire-and-forget execution.
 *
 * Returns a result type instead of throwing — callers decide how to surface errors
 * (e.g. throw ApiError for HTTP routes, or failSchedule for scheduled runs).
 */
export async function prepareAndExecuteRun(params: RunPipelineParams): Promise<RunPipelineResult> {
  const {
    runId,
    agent,
    providerProfiles,
    orgId,
    actor,
    input,
    files,
    config,
    modelId,
    proxyId,
    overrideVersionLabel,
    scheduleId,
    connectionProfileId,
    applicationId,
    uploadedFiles,
    apiKeyId,
  } = params;

  // --- Step 1: Build run context ---
  let promptContext;
  let agentPackage: Buffer | null;
  let versionLabel: string | null;
  let versionDirty: boolean;
  let proxyLabel: string | null;
  let modelLabel: string | null;
  let modelSource: string | null;
  try {
    ({
      promptContext,
      agentPackage,
      versionLabel,
      versionDirty,
      proxyLabel,
      modelLabel,
      modelSource,
    } = await buildRunContext({
      runId,
      agent,
      providerProfiles,
      orgId,
      applicationId,
      actor,
      input: input ?? undefined,
      files,
      config,
      modelId,
      proxyId,
      overrideVersionLabel,
    }));
  } catch (err) {
    if (err instanceof ModelNotConfiguredError) {
      return { ok: false, error: { code: "model_not_configured", message: err.message } };
    }
    return {
      ok: false,
      error: { code: "unexpected", message: err instanceof Error ? err.message : String(err) },
    };
  }

  // --- Step 2: Snapshot provider statuses ---
  let providerStatusSnapshots: RunProviderSnapshot[] | undefined;
  const manifestProviders = resolveManifestProviders(agent.manifest);
  if (manifestProviders.length > 0) {
    const statuses = await resolveProviderStatuses(
      manifestProviders,
      providerProfiles,
      orgId,
      applicationId,
    );
    providerStatusSnapshots = statuses.map((s) => ({
      id: s.id,
      status: s.status,
      source: s.source,
      profileName: s.profileName,
      profileOwnerName: s.profileOwnerName,
      ...(s.scopesSufficient != null ? { scopesSufficient: s.scopesSufficient } : {}),
    }));
  }

  // --- Step 3: Pre-run module hook (quota, rate limits, feature gates, etc.) ---
  if (hasHook("beforeRun")) {
    const runningCount = await getRunningRunCountForOrg(orgId);
    const rejection = await callHook("beforeRun", { orgId, packageId: agent.id, runningCount });
    if (rejection) {
      return {
        ok: false,
        error: { code: rejection.code, message: rejection.message, status: rejection.status },
      };
    }
  }

  // --- Step 4: Extract profile ID map ---
  const profileIdMap = Object.fromEntries(
    Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
  );

  // --- Step 5: Create run record ---
  const agentDenorm = extractRunAgentDenorm(agent);
  await createRun({
    id: runId,
    packageId: agent.id,
    actor,
    orgId,
    applicationId,
    input: input ?? null,
    scheduleId,
    connectionProfileId,
    versionLabel: versionLabel ?? undefined,
    versionDirty,
    proxyLabel: proxyLabel ?? undefined,
    modelLabel: modelLabel ?? undefined,
    modelSource: modelSource ?? undefined,
    providerProfileIds: profileIdMap,
    providerStatuses: providerStatusSnapshots,
    apiKeyId,
    agentScope: agentDenorm.scope,
    agentName: agentDenorm.name,
  });

  // --- Step 6: Fire-and-forget execution ---
  executeAgentInBackground(
    runId,
    orgId,
    agent,
    promptContext,
    applicationId,
    agentPackage,
    uploadedFiles,
    modelSource,
  ).catch((err) => {
    logger.error("Unhandled error in background run", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true, runId, modelSource };
}
