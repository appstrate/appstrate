// SPDX-License-Identifier: Apache-2.0

/**
 * Shared run pipeline — the common tail of "build context ��� quota check → create run → execute".
 * Used by both the POST /run route and the scheduler's triggerScheduledRun.
 */

import { logger } from "../lib/logger.ts";
import { buildRunContext, ModelNotConfiguredError } from "./env-builder.ts";
import { getCloudModule } from "../lib/cloud-loader.ts";
import { createRun, getRunningRunCountForOrg } from "./state/index.ts";
import { executeAgentInBackground } from "../routes/runs.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { UploadedFile, FileReference } from "./adapters/types.ts";

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
  overrideVersionId?: number;
  /** Schedule ID — set only for scheduled runs. */
  scheduleId?: string;
  /** Connection profile ID used to create the run. */
  connectionProfileId?: string;
  /** Application ID for webhook scoping. */
  applicationId?: string | null;
  /** Uploaded files to inject into the container. */
  uploadedFiles?: UploadedFile[];
}

export type RunPipelineError =
  | { code: "model_not_configured"; message: string }
  | { code: "quota_exceeded"; message: string }
  | { code: "unexpected"; message: string };

export type RunPipelineResult =
  | { ok: true; runId: string; modelSource: string | null }
  | { ok: false; error: RunPipelineError };

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Build run context, check quota, create run record, and fire-and-forget execution.
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
    overrideVersionId,
    scheduleId,
    connectionProfileId,
    applicationId,
    uploadedFiles,
  } = params;

  // --- Step 1: Build run context ---
  let promptContext;
  let agentPackage: Buffer | null;
  let packageVersionId: number | null;
  let proxyLabel: string | null;
  let modelLabel: string | null;
  let modelSource: string | null;
  try {
    ({ promptContext, agentPackage, packageVersionId, proxyLabel, modelLabel, modelSource } =
      await buildRunContext({
        runId,
        agent,
        providerProfiles,
        orgId,
        actor,
        input: input ?? undefined,
        files,
        config,
        modelId,
        proxyId,
        overrideVersionId,
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

  // --- Step 2: Quota check (Cloud only) ---
  const cloud = getCloudModule();
  if (cloud) {
    try {
      const runningCount = await getRunningRunCountForOrg(orgId);
      await cloud.cloudHooks.checkQuota(orgId, runningCount);
    } catch (err) {
      if (err instanceof cloud.QuotaExceededError) {
        return { ok: false, error: { code: "quota_exceeded", message: err.message } };
      }
      return {
        ok: false,
        error: { code: "unexpected", message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // --- Step 3: Extract profile ID map ---
  const profileIdMap = Object.fromEntries(
    Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
  );

  // --- Step 4: Create run record ---
  await createRun(
    runId,
    agent.id,
    actor,
    orgId,
    input ?? null,
    scheduleId,
    packageVersionId ?? undefined,
    connectionProfileId,
    proxyLabel ?? undefined,
    modelLabel ?? undefined,
    modelSource ?? undefined,
    applicationId ?? undefined,
    profileIdMap,
  );

  // --- Step 5: Fire-and-forget execution ---
  executeAgentInBackground(
    runId,
    orgId,
    agent,
    promptContext,
    agentPackage,
    uploadedFiles,
    applicationId,
    modelSource,
  ).catch((err) => {
    logger.error("Unhandled error in background run", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { ok: true, runId, modelSource };
}
