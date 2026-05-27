// SPDX-License-Identifier: Apache-2.0

/**
 * Shared run pipeline — the common tail of "build context → pre-run hooks → create run → execute".
 * Used by both the POST /run route and the scheduler's triggerScheduledRun.
 */

import { logger } from "../lib/logger.ts";
import { buildRunContext, ModelNotConfiguredError } from "./env-builder.ts";
import { createRun } from "./state/runs.ts";
import { getPackageConfig } from "./application-packages.ts";
import { executeAgentInBackground } from "../routes/runs.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { resolveRunConnectionsOrError } from "./integration-connection-resolver.ts";
import type { ConnectionOverrides, ResolvedConnectionMap } from "@appstrate/core/integration";
import { parseScopedName } from "@appstrate/core/naming";
import { mintSinkCredentials } from "../lib/mint-sink-credentials.ts";
import { encrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { getOrchestrator } from "./orchestrator/index.ts";
import { ApiError } from "../lib/errors.ts";
import type { LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { UploadedFile, FileReference } from "./run-launcher/types.ts";
import { runPreflightGates } from "./run-preflight-gates.ts";
import { getErrorMessage } from "@appstrate/core/errors";

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
    typeof pkg.manifest.display_name === "string"
      ? pkg.manifest.display_name
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
  orgId: string;
  actor: Actor | null;
  input?: Record<string, unknown> | null;
  files?: FileReference[];
  config: Record<string, unknown>;
  /**
   * Per-run override delta — the raw object the caller sent in the request
   * body. `config` above is the resolved (deep-merged) snapshot. Persisted
   * separately on `runs.config_override` so the dashboard can badge
   * "default vs override" and a "Re-run with these settings" button can
   * replay the exact same delta. Null when the run used persisted defaults.
   */
  configOverride?: Record<string, unknown> | null;
  modelId?: string | null;
  proxyId?: string | null;
  overrideVersionLabel?: string;
  /** Schedule ID — set only for scheduled runs. */
  scheduleId?: string;
  /** Application ID — required for all runs. */
  applicationId: string;
  /** Uploaded files to inject into the container. */
  uploadedFiles?: UploadedFile[];
  /** API key ID that triggered the run (if auth via API key). */
  apiKeyId?: string;
  /**
   * Per-(integration, authKey) connection id chosen by the caller for
   * THIS run (#199). Persisted on `runs.connection_overrides` as the
   * audit trail and fed into the resolver's mechanism #2 so the snapshot
   * pins the right row. Loses to admin pins (mechanism #1).
   */
  connectionOverrides?: ConnectionOverrides | null;
  /**
   * Schedule-frozen overrides loaded from `package_schedules.connection_overrides`.
   * Same shape as `connectionOverrides`; loses to both admin pins and
   * per-run overrides. Scheduler path only.
   */
  scheduleConnectionOverrides?: ConnectionOverrides | null;
  /**
   * W3C `traceparent` header value of the spawning request. Forwarded
   * into the runtime so its outbound traffic becomes child spans of
   * the platform's trace. Routes pull this from `c.get("traceparent")`;
   * background runners (scheduler) leave it unset.
   */
  traceparent?: string;
  /** Resolved by `lib/runner-context.ts` from request headers + auth context. */
  runnerName?: string | null;
  runnerKind?: string | null;
}

export interface RunPipelineSuccess {
  runId: string;
  modelSource: string | null;
}

// ---------------------------------------------------------------------------
// Preflight — shared by run route and scheduler
// ---------------------------------------------------------------------------

export interface PreflightResult {
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
}

/**
 * Resolve package config and validate agent readiness.
 * Shared by the POST /run route and the scheduler's triggerScheduledRun.
 */
export async function resolveRunPreflight(params: {
  agent: LoadedPackage;
  applicationId: string;
  orgId: string;
  actor: Actor | null;
}): Promise<PreflightResult> {
  const { agent, applicationId, orgId, actor } = params;

  const packageConfig = await getPackageConfig(applicationId, agent.id);

  await validateAgentReadiness({
    agent,
    orgId,
    config: packageConfig.config,
    applicationId,
    actor,
  });

  return {
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
 * Throws `ApiError` on validation / preflight failures (model not configured,
 * rate limit, concurrency, beforeRun hook rejection) so the HTTP error handler
 * can surface RFC 9457 problem details directly. Background callers (scheduler)
 * catch `ApiError` to translate into their own failure semantics.
 */
export async function prepareAndExecuteRun(params: RunPipelineParams): Promise<RunPipelineSuccess> {
  const {
    runId,
    orgId,
    actor,
    input,
    files,
    config,
    modelId,
    proxyId,
    overrideVersionLabel,
    scheduleId,
    applicationId,
    uploadedFiles,
    apiKeyId,
  } = params;
  // --- Step 1: Shared preflight gates (rate, concurrency, timeout cap,
  //     beforeRun hook). Shared with the remote origin in run-creation.ts so
  //     drift across the two paths is impossible — one change surface.
  const gates = await runPreflightGates({
    orgId,
    agent: params.agent,
  });
  if (!gates.ok) {
    throw new ApiError({
      status: gates.error.status ?? 500,
      code: gates.error.code,
      title: gates.error.code.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      detail: gates.error.message,
    });
  }
  const { agent } = gates;

  // --- Step 2: Connection resolution snapshot (#199) ---
  //
  // Apply the 4-mechanism cascade once at kickoff so:
  //  - the spawn loader (env-builder) pins the same row admin/run intended,
  //  - the credentials resolver (sidecar MITM refresh) honours that pick
  //    long after kickoff via runs.resolved_connections.
  //
  // Readiness already ran in resolveRunPreflight WITHOUT overrides — this
  // pass adds the per-run picks. Any error here is hard 412: either the
  // override points at an invalid id (caller's mistake), or a race after
  // readiness mutated DB state (connection deleted / pin shifted). Either
  // way the caller needs structured feedback, not a silent fallback.
  let resolvedConnections: ResolvedConnectionMap | null = null;
  if (actor) {
    const outcome = await resolveRunConnectionsOrError({
      agentManifest: agent.manifest as Record<string, unknown>,
      packageId: agent.id,
      actor,
      scope: { orgId, applicationId },
      runOverrides: params.connectionOverrides ?? null,
      scheduleOverrides: params.scheduleConnectionOverrides ?? null,
    });
    if (!outcome.ok) {
      throw new ApiError({
        status: outcome.error.status,
        code: outcome.error.code,
        title: outcome.error.title,
        detail: outcome.error.detail,
        errors: outcome.error.errors,
      });
    }
    resolvedConnections = outcome.resolved;
  }

  // --- Step 3: Build run context ---
  let context;
  let plan;
  let agentPackage: Buffer | null;
  let versionLabel: string | null;
  let versionDirty: boolean;
  let proxyLabel: string | null;
  let modelLabel: string | null;
  let modelSource: string | null;
  try {
    ({
      context,
      plan,
      agentPackage,
      versionLabel,
      versionDirty,
      proxyLabel,
      modelLabel,
      modelSource,
    } = await buildRunContext({
      runId,
      agent,
      orgId,
      applicationId,
      actor,
      input: input ?? undefined,
      files,
      config,
      modelId,
      proxyId,
      overrideVersionLabel,
      traceparent: params.traceparent,
      resolvedConnections,
    }));
  } catch (err) {
    if (err instanceof ModelNotConfiguredError) {
      throw new ApiError({
        status: 400,
        code: "model_not_configured",
        title: "Bad Request",
        detail: err.message,
      });
    }
    throw err;
  }

  // --- Step 4: Mint sink credentials ---
  // Every run — platform and remote — uses the same signed-event
  // protocol. The container reads `APPSTRATE_SINK_URL` +
  // `APPSTRATE_SINK_SECRET` from its env and POSTs CloudEvents back;
  // the platform's event-ingestion pipeline is the single writer.
  //
  // The base URL comes from the orchestrator — `APP_URL` is a public
  // hostname meant for OAuth redirects and CLI clients, not for
  // container-to-platform traffic. Docker orchestrator resolves to the
  // platform's Docker-network hostname (bridge-internal, survives
  // container renames); process orchestrator resolves to loopback.
  const env = getEnv();
  const sinkBaseUrl = await getOrchestrator().resolvePlatformApiUrl();
  const sinkCredentials = mintSinkCredentials({
    runId,
    appUrl: sinkBaseUrl,
    ttlSeconds: env.REMOTE_RUN_SINK_DEFAULT_TTL_SECONDS,
  });

  // --- Step 5: Create run record (with sink state) ---
  const agentDenorm = extractRunAgentDenorm(agent);
  await createRun(
    { orgId, applicationId },
    {
      id: runId,
      packageId: agent.id,
      actor,
      input: input ?? null,
      scheduleId,
      versionLabel: versionLabel ?? undefined,
      versionDirty,
      proxyLabel: proxyLabel ?? undefined,
      modelLabel: modelLabel ?? undefined,
      modelSource: modelSource ?? undefined,
      apiKeyId,
      agentScope: agentDenorm.scope,
      agentName: agentDenorm.name,
      config,
      configOverride: params.configOverride ?? null,
      runOrigin: "platform",
      sinkSecretEncrypted: encrypt(sinkCredentials.secret),
      sinkExpiresAt: new Date(sinkCredentials.expiresAt),
      connectionOverrides: params.connectionOverrides ?? null,
      resolvedConnections,
      runnerName: params.runnerName ?? null,
      runnerKind: params.runnerKind ?? null,
      modelCredentialId: plan.llmConfig.credentialId ?? null,
    },
  );

  // --- Step 6: Fire-and-forget execution ---
  executeAgentInBackground({
    runId,
    orgId,
    applicationId,
    agent,
    context,
    plan,
    agentPackage,
    inputFiles: uploadedFiles,
    modelSource,
    sinkCredentials,
  }).catch((err) => {
    logger.error("Unhandled error in background run", {
      runId,
      error: getErrorMessage(err),
    });
  });

  return { runId, modelSource };
}
