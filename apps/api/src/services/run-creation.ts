// SPDX-License-Identifier: Apache-2.0

/**
 * Unified run creation — single entry point for every runs-creating route.
 *
 * - `origin: "platform"` — the platform container will execute the agent.
 * - `origin: "remote"`   — the caller (CLI, GitHub Action, ...) will execute
 *                          the agent on their own host. We mint sink
 *                          credentials, create the `runs` row in `pending`,
 *                          and return the credentials. Status transitions
 *                          (`pending → running → terminal`) flow through
 *                          the signed-event route (§run-event-ingestion).
 *
 * Both origins share:
 *   - Platform run limits (org rate, concurrency, timeout ceiling)
 *   - `beforeRun` module hook (billing/quota/feature-gate rejects)
 *   - Provider readiness (the agent needs configured credentials to run)
 *   - `onRunStatusChange` event firing (consumers stay origin-agnostic)
 *
 * Spec: docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md §6.2.
 */

import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { mintSinkCredentials, type SinkCredentials } from "../lib/mint-sink-credentials.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { FileReference, UploadedFile } from "./adapters/types.ts";
import { prepareAndExecuteRun, extractRunAgentDenorm } from "./run-pipeline.ts";
import type { RunPipelineResult } from "./run-pipeline.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { resolveProviderStatuses } from "./connection-manager/index.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { getPlatformRunLimits } from "./run-limits.ts";
import { checkOrgRunRateLimit } from "./org-run-rate-limit.ts";
import { getRunningRunCountForOrg } from "./state/index.ts";
import { callHook, hasHook, emitEvent } from "../lib/modules/module-loader.ts";
import type { RunProviderSnapshot } from "@appstrate/shared-types";
import { isInlineShadowPackageId } from "./inline-run.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunOrigin = "platform" | "remote";

export interface SinkRequest {
  /** Client-requested TTL in seconds. Clamped to REMOTE_RUN_SINK_MAX_TTL_SECONDS. */
  ttlSeconds?: number;
}

// SinkCredentials + mintSinkCredentials live in
// `../lib/mint-sink-credentials.ts` (pure, no db imports) so unit tests
// can exercise the URL / secret derivation without spinning up the DB.
// Re-exported here for callers already importing from this service.
export { mintSinkCredentials };
export type { SinkCredentials };

export interface CreateRunInput {
  origin: RunOrigin;
  runId: string;
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  agent: LoadedPackage;
  providerProfiles: ProviderProfileMap;
  input?: Record<string, unknown> | null;
  files?: FileReference[];
  config: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  apiKeyId?: string;
  scheduleId?: string;
  connectionProfileId?: string;
  overrideVersionLabel?: string;
  uploadedFiles?: UploadedFile[];
  /** Only meaningful when `origin === "remote"` — ignored for platform origin. */
  sink?: SinkRequest;
  /** CLI-provided execution environment metadata (os, cli version, git sha, ...). */
  contextSnapshot?: Record<string, unknown>;
}

export type CreateRunResult =
  | {
      ok: true;
      runId: string;
      /** Present only for `origin: "remote"`. */
      sinkCredentials?: SinkCredentials;
    }
  | {
      ok: false;
      error: { code: string; message: string; status?: number };
    };

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Create a run. For platform origin, delegates to {@link prepareAndExecuteRun}
 * (in-process executor, unchanged). For remote origin, runs the same preflight
 * gates, mints sink credentials, creates the `runs` row in `pending`, and
 * returns — the CLI executes on its own host and posts events back.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  if (input.origin === "platform") {
    const result: RunPipelineResult = await prepareAndExecuteRun({
      runId: input.runId,
      agent: input.agent,
      providerProfiles: input.providerProfiles,
      orgId: input.orgId,
      actor: input.actor,
      input: input.input ?? null,
      files: input.files,
      config: input.config,
      modelId: input.modelId,
      proxyId: input.proxyId,
      applicationId: input.applicationId,
      apiKeyId: input.apiKeyId,
      scheduleId: input.scheduleId,
      connectionProfileId: input.connectionProfileId,
      overrideVersionLabel: input.overrideVersionLabel,
      uploadedFiles: input.uploadedFiles,
    });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, runId: result.runId };
  }

  return createRemoteRun(input);
}

// ---------------------------------------------------------------------------
// Remote origin — preflight, mint sink, insert row, no execution
// ---------------------------------------------------------------------------

async function createRemoteRun(input: CreateRunInput): Promise<CreateRunResult> {
  const {
    runId,
    orgId,
    applicationId,
    actor,
    agent,
    providerProfiles,
    input: runInput,
    config,
    apiKeyId,
    connectionProfileId,
    contextSnapshot,
  } = input;

  // --- Platform run limits (same gates as platform path) ---
  const platformLimits = getPlatformRunLimits();

  const rateCheck = await checkOrgRunRateLimit(orgId, platformLimits.per_org_global_rate_per_min);
  if (!rateCheck.ok) {
    return {
      ok: false,
      error: {
        code: "org_run_rate_limited",
        message: `Organization rate limit reached (${platformLimits.per_org_global_rate_per_min}/min). Retry in ${rateCheck.retryAfterSeconds}s.`,
        status: 429,
      },
    };
  }

  const runningCount = await getRunningRunCountForOrg({ orgId });
  if (runningCount >= platformLimits.max_concurrent_per_org) {
    return {
      ok: false,
      error: {
        code: "org_run_concurrency_exceeded",
        message: `Organization concurrent run limit reached (${platformLimits.max_concurrent_per_org}). Wait for in-flight runs to complete.`,
        status: 429,
      },
    };
  }

  // --- Provider readiness ---
  try {
    await validateAgentReadiness({
      agent,
      providerProfiles,
      orgId,
      config,
      applicationId,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "agent_not_ready",
        message: err instanceof Error ? err.message : String(err),
        status: 400,
      },
    };
  }

  // --- Provider-status snapshot (for the runs row; mirrors platform path) ---
  let providerStatusSnapshots: RunProviderSnapshot[] | undefined;
  const manifestProviders = resolveManifestProviders(agent.manifest);
  if (manifestProviders.length > 0) {
    const statuses = await resolveProviderStatuses(
      { orgId, applicationId },
      manifestProviders,
      providerProfiles,
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

  // --- beforeRun module hook (billing/quota/feature gates) ---
  if (hasHook("beforeRun")) {
    const rejection = await callHook("beforeRun", { orgId, packageId: agent.id, runningCount });
    if (rejection) {
      return { ok: false, error: rejection };
    }
  }

  // --- Mint sink credentials ---
  const env = getEnv();
  const ttlSeconds = Math.min(
    input.sink?.ttlSeconds ?? env.REMOTE_RUN_SINK_DEFAULT_TTL_SECONDS,
    env.REMOTE_RUN_SINK_MAX_TTL_SECONDS,
  );
  const credentials = mintSinkCredentials({
    runId,
    appUrl: env.APP_URL,
    ttlSeconds,
  });

  // --- Insert run row (pending, with sink state populated) ---
  const agentDenorm = extractRunAgentDenorm(agent);
  const profileIdMap = Object.fromEntries(
    Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
  );

  await db.insert(runs).values({
    id: runId,
    packageId: agent.id,
    orgId,
    applicationId,
    status: "pending",
    input: runInput ?? null,
    dashboardUserId: actor?.type === "member" ? actor.id : null,
    endUserId: actor?.type === "end_user" ? actor.id : null,
    apiKeyId: apiKeyId ?? null,
    connectionProfileId: connectionProfileId ?? null,
    agentScope: agentDenorm.scope,
    agentName: agentDenorm.name,
    providerProfileIds: profileIdMap,
    providerStatuses: providerStatusSnapshots ?? null,
    config,
    runOrigin: "remote",
    sinkSecretEncrypted: encrypt(credentials.secret),
    sinkExpiresAt: new Date(credentials.expiresAt),
    contextSnapshot: contextSnapshot ?? null,
  });

  // --- Status-change event (consumers stay origin-agnostic) ---
  void emitEvent("onRunStatusChange", {
    orgId,
    runId,
    packageId: agent.id,
    applicationId,
    status: "started",
    packageEphemeral: isInlineShadowPackageId(agent.id),
  });

  return { ok: true, runId, sinkCredentials: credentials };
}
