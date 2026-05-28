// SPDX-License-Identifier: Apache-2.0

/**
 * Remote run creation — entry point for the remote-runner route
 * (`POST /api/runs/remote`). The caller (CLI, GitHub Action, ...) is the
 * runner: we run readiness + preflight, mint sink credentials, create the
 * `runs` row in `pending`, and return the credentials. Status transitions
 * flow back through the HMAC-signed event route (§run-event-ingestion).
 *
 * Platform-origin runs (the platform spawns the Docker container) do NOT
 * pass through here — they go straight to {@link prepareAndExecuteRun}
 * from `runs.ts` / `scheduler.ts` / `inline-run.ts`. Both paths share the
 * same building blocks: `runPreflightGates` (rate/concurrency/timeout +
 * `beforeRun` hook), the connection-cascade resolver, the state-layer
 * `createRun` insert, and the `onRunStatusChange` event.
 *
 * Spec: docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md §6.2.
 */

import { encrypt } from "@appstrate/connect";
import { getEnv } from "@appstrate/env";
import { mintSinkCredentials, type SinkCredentials } from "../lib/mint-sink-credentials.ts";
import type { LoadedPackage } from "../types/index.ts";
import type { Actor } from "../lib/actor.ts";
import { extractRunAgentDenorm } from "./run-pipeline.ts";
import { validateAgentReadiness } from "./agent-readiness.ts";
import { resolveRunConnectionsOrError } from "./integration-connection-resolver.ts";
import type { ResolvedConnectionMap } from "@appstrate/core/integration";
import { createRun as createRunRow } from "./state/runs.ts";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "./inline-run.ts";
import { runPreflightGates } from "./run-preflight-gates.ts";
import { getErrorMessage } from "@appstrate/core/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  runId: string;
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  agent: LoadedPackage;
  input?: Record<string, unknown> | null;
  config: Record<string, unknown>;
  modelId?: string | null;
  proxyId?: string | null;
  apiKeyId?: string;
  overrideVersionLabel?: string;
  /**
   * Caller's per-(integration, authKey) connection picks for THIS run
   * (#199). Flows into the resolver's mechanism #2 at kickoff and is
   * persisted on `runs.connection_overrides` for audit + replay.
   */
  connectionOverrides?: Record<string, string> | null;
  /** Client-requested sink TTL. */
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
      sinkCredentials?: SinkCredentials;
    }
  | {
      ok: false;
      error: { code: string; message: string; status?: number };
    };

// ---------------------------------------------------------------------------
// Public entry point — preflight, mint sink, insert row, no execution
// ---------------------------------------------------------------------------

/**
 * Create a remote run: run readiness + preflight gates, mint sink
 * credentials, insert the `runs` row in `pending`, and return — the CLI
 * executes on its own host and posts signed events back.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  const {
    runId,
    orgId,
    applicationId,
    actor,
    input: runInput,
    config,
    apiKeyId,
    contextSnapshot,
    overrideVersionLabel,
  } = input;

  // --- Provider readiness — runs first so remote callers get a readable
  //     400 before we spend any rate-limit / concurrency budget on them.
  try {
    await validateAgentReadiness({
      agent: input.agent,
      orgId,
      config,
      applicationId,
      actor,
      // Forward overrides so a remote retry with `connection_overrides`
      // exits the must_choose loop instead of re-firing 412 on the same
      // candidate set.
      ...(input.connectionOverrides ? { runOverrides: input.connectionOverrides } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "agent_not_ready",
        message: getErrorMessage(err),
        status: 400,
      },
    };
  }

  // --- Shared preflight: rate, concurrency, timeout cap, beforeRun hook.
  //     Single source of truth across platform / remote / scheduled origins.
  const gates = await runPreflightGates({
    orgId,
    agent: input.agent,
  });
  if (!gates.ok) return { ok: false, error: gates.error };
  const { agent } = gates;

  // --- Snapshot the connection cascade (#199, remote-path mirror of
  //     run-pipeline). Readiness above ran with the same overrides, so a
  //     failure here is either the caller's pick pointing at an inaccessible
  //     id or a between-readiness-and-now race (deleted connection, new admin
  //     pin). Either way the runner gets a structured agent_not_ready it can
  //     surface verbatim.
  let resolvedConnections: ResolvedConnectionMap | null = null;
  if (actor) {
    const outcome = await resolveRunConnectionsOrError({
      agentManifest: agent.manifest as Record<string, unknown>,
      packageId: agent.id,
      actor,
      scope: { orgId, applicationId },
      runOverrides: input.connectionOverrides ?? null,
      // Remote runs are never scheduled, so there is no frozen schedule
      // override on this path (mechanism #3 applies to platform runs only).
      scheduleOverrides: null,
    });
    if (!outcome.ok) {
      // Remote runners get a flat `agent_not_ready` they can surface verbatim
      // — no structured `errors[]` channel on the result shape. Preserve the
      // historical code/status; the human-readable detail is the first error.
      return {
        ok: false,
        error: {
          code: "agent_not_ready",
          message: outcome.error.detail,
          status: outcome.error.status,
        },
      };
    }
    resolvedConnections = outcome.resolved;
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

  // --- Insert run row via the state-layer helper (single source of truth
  //     for runs inserts — covers runNumber allocation, app-scoping, and
  //     sink bookkeeping consistently across both origins).
  const agentDenorm = extractRunAgentDenorm(agent);

  await createRunRow(
    { orgId, applicationId },
    {
      id: runId,
      packageId: agent.id,
      actor,
      input: runInput ?? null,
      apiKeyId,
      agentScope: agentDenorm.scope,
      agentName: agentDenorm.name,
      config,
      runOrigin: "remote",
      sinkSecretEncrypted: encrypt(credentials.secret),
      sinkExpiresAt: new Date(credentials.expiresAt),
      connectionOverrides: input.connectionOverrides ?? null,
      resolvedConnections,
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
