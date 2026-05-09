// SPDX-License-Identifier: Apache-2.0

/**
 * Unified run creation — single entry point for every runs-creating route.
 *
 * - `origin: "platform"` — the platform spawns a Docker container that
 *                          talks the exact same HMAC-signed event protocol
 *                          as any remote runner. Delegates to
 *                          {@link prepareAndExecuteRun} for the heavy
 *                          container plan + fire-and-forget execution.
 * - `origin: "remote"`   — the caller (CLI, GitHub Action, ...) is the
 *                          runner. We mint sink credentials, create the
 *                          `runs` row in `pending`, and return the
 *                          credentials. Status transitions flow through
 *                          the signed-event route (§run-event-ingestion).
 *
 * Both origins share:
 *   - Platform run limits (org rate, concurrency, timeout ceiling)
 *   - `beforeRun` module hook (billing/quota/feature-gate rejects)
 *   - Provider readiness (the agent needs configured credentials to run)
 *   - `onRunStatusChange` event firing (consumers stay origin-agnostic)
 *   - HMAC-signed event ingestion at `POST /api/runs/:runId/events`
 *
 * Spec: docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md §6.2.
 */

import { encrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { mintSinkCredentials, type SinkCredentials } from "../lib/mint-sink-credentials.ts";
import type { LoadedPackage, ProviderProfileMap } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import type { FileReference, UploadedFile } from "./run-launcher/types.ts";
import { prepareAndExecuteRun, extractRunAgentDenorm } from "./run-pipeline.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { createRun as createRunRow } from "./state/runs.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "./inline-run.ts";
import { runPreflightGates } from "./run-preflight-gates.ts";
import { ApiError } from "../lib/errors.ts";
import type { RunOrigin } from "@appstrate/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RunOrigin };

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
  /** Resolved by `lib/runner-context.ts` from request headers + auth context. */
  runnerName?: string | null;
  runnerKind?: string | null;
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
 * (builds the container plan + mints sink credentials + fires the container).
 * For remote origin, runs the same preflight gates, mints sink credentials,
 * creates the `runs` row in `pending`, and returns — the CLI executes on its
 * own host and posts events back.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  if (input.origin === "platform") {
    try {
      const result = await prepareAndExecuteRun({
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
        runnerName: input.runnerName ?? null,
        runnerKind: input.runnerKind ?? null,
      });
      return { ok: true, runId: result.runId };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          ok: false,
          error: { code: err.code, message: err.message, status: err.status },
        };
      }
      throw err;
    }
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
    providerProfiles,
    input: runInput,
    config,
    apiKeyId,
    connectionProfileId,
    contextSnapshot,
    overrideVersionLabel,
  } = input;

  // --- Provider readiness — runs first so remote callers get a readable
  //     400 before we spend any rate-limit / concurrency budget on them.
  try {
    await validateAgentReadiness({
      agent: input.agent,
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

  // --- Shared preflight: rate, concurrency, timeout cap, beforeRun hook,
  //     provider status snapshot. Single source of truth across platform /
  //     remote / scheduled origins.
  const gates = await runPreflightGates({
    orgId,
    applicationId,
    agent: input.agent,
    providerProfiles,
  });
  if (!gates.ok) return { ok: false, error: gates.error };
  const { agent, providerStatusSnapshots } = gates;

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

  // --- Insert run row via the state-layer helper (single source of truth
  //     for runs inserts — covers runNumber allocation, app-scoping, and
  //     sink bookkeeping consistently across both origins).
  const agentDenorm = extractRunAgentDenorm(agent);
  const profileIdMap = Object.fromEntries(
    Object.entries(providerProfiles).map(([k, v]) => [k, v.profileId]),
  );

  await createRunRow(
    { orgId, applicationId },
    {
      id: runId,
      packageId: agent.id,
      actor,
      input: runInput ?? null,
      connectionProfileId,
      apiKeyId,
      providerProfileIds: profileIdMap,
      providerStatuses: providerStatusSnapshots,
      agentScope: agentDenorm.scope,
      agentName: agentDenorm.name,
      config,
      runOrigin: "remote",
      sinkSecretEncrypted: encrypt(credentials.secret),
      sinkExpiresAt: new Date(credentials.expiresAt),
      ...(overrideVersionLabel ? { versionLabel: overrideVersionLabel } : {}),
      ...(contextSnapshot !== undefined ? { contextSnapshot } : {}),
      runnerName: input.runnerName ?? null,
      runnerKind: input.runnerKind ?? null,
    },
  );

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
