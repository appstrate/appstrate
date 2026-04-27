// SPDX-License-Identifier: Apache-2.0

/**
 * Run event ingestion — the single writer behind `POST /api/runs/:runId/events`
 * and `POST /api/runs/:runId/events/finalize`.
 *
 * Platform containers and remote CLIs both post events here over HMAC-signed
 * HTTP. The route handler authenticates via `verifyRunSignature` middleware
 * (which populates `c.get("run")`), then delegates to one of:
 *
 *   - {@link ingestRunEvent}      — single signed CloudEvent → replay check
 *                                   → ordering buffer → AppstrateEventSink.handle
 *                                   → sequence counter advance
 *   - {@link finalizeRun}   — terminal RunResult → flush buffer → close
 *                                   sink → afterRun / onRunStatusChange hooks
 *
 * Invariant: `appendRunLog()` and status-lifecycle updates have **exactly one**
 * caller chain, rooted here. `AppstrateEventSink.handle()` is instantiated
 * inside `ingestRunEvent`; it is never called from anywhere else.
 *
 * See `docs/specs/REMOTE_CLI_UNIFIED_RUNNER_PLAN.md` §6.3, §7 for the full
 * design.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { type CloudEventEnvelope } from "@appstrate/afps-runtime/events";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { notFound } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";
import { getCache, getEventBuffer } from "../infra/index.ts";
import { getEnv } from "@appstrate/env";
import {
  PersistingEventSink,
  hasRunnerLedgerRow,
  writeRunnerLedgerRow,
} from "./adapters/appstrate-event-sink.ts";
import { updateRun, appendRunLog } from "./state/runs.ts";
import {
  addMemories as addUnifiedMemories,
  upsertPinned,
  scopeFromActor,
  CHECKPOINT_KEY,
} from "./state/package-persistence.ts";
import { actorFromIds } from "../lib/actor.ts";
import { getPackage } from "./agent-service.ts";
import { validateOutput } from "./schema.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { callHook, emitEvent } from "../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "./inline-run.ts";
import type { RunStatusChangeParams } from "@appstrate/core/module";
import { computeRunCost } from "./credential-proxy-usage.ts";
import { assertSinkOpen, verifyRunSignatureHeaders } from "../lib/run-signature.ts";
import type { TokenUsage } from "./adapters/types.ts";

// Re-export the pure helpers so callers that already import from this
// service don't have to change.
export { assertSinkOpen, verifyRunSignatureHeaders };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// RunSinkContext moved to apps/api/src/types/run-sink.ts so `AppEnv` can
// reference it without pulling the full event-ingestion module into every
// consumer of `AppEnv` (which transitively includes the web-side code via
// shared imports from `apps/api/src/modules/oidc/...`).
export type { RunSinkContext } from "../types/run-sink.ts";
import type { RunSinkContext } from "../types/run-sink.ts";

export type IngestOutcome =
  | { status: "persisted"; sequence: number }
  | { status: "replay" }
  | { status: "buffered"; sequence: number };

export interface IngestRunEventInput {
  run: RunSinkContext;
  envelope: CloudEventEnvelope;
  webhookId: string;
}

export interface FinalizeRunInput {
  run: RunSinkContext;
  result: RunResult;
  webhookId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Terminal RunEvent types — flush ordering buffer unconditionally. */
const TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.timeout",
  "run.cancelled",
]);

/** Key prefix for webhook-id replay dedup. */
const REPLAY_KEY_PREFIX = "appstrate:remote-run:replay:";

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Single-row PK lookup of the sink-relevant columns. Returns `null` when the
 * run does not exist — the middleware maps to 404.
 */
export async function getRunSinkContext(runId: string): Promise<RunSinkContext | null> {
  const [row] = await db
    .select({
      id: runs.id,
      orgId: runs.orgId,
      applicationId: runs.applicationId,
      packageId: runs.packageId,
      runOrigin: runs.runOrigin,
      sinkSecretEncrypted: runs.sinkSecretEncrypted,
      sinkExpiresAt: runs.sinkExpiresAt,
      sinkClosedAt: runs.sinkClosedAt,
      lastEventSequence: runs.lastEventSequence,
      startedAt: runs.startedAt,
      modelSource: runs.modelSource,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return null;
  if (row.sinkSecretEncrypted === null) return null;
  return row as RunSinkContext;
}

// `assertSinkOpen` and `verifyRunSignatureHeaders` live in
// `../lib/run-signature.ts` and are re-exported at the top of this file.
// Pulling them out of this module keeps the signature-verification unit
// tests from requiring the db client's env invariants.

// ---------------------------------------------------------------------------
// Ingestion — single signed event
// ---------------------------------------------------------------------------

/**
 * Process one CloudEvent envelope:
 *
 *   1. Reject if the `webhook-id` has already been processed for this run
 *      (Redis dedup; idempotent 200 to the caller).
 *   2. If `envelope.sequence === last_event_sequence + 1`, fast-path: CAS
 *      the counter, dispatch to {@link AppstrateEventSink}, and return.
 *   3. Otherwise, append to a per-run Redis sorted set keyed by sequence.
 *      The next contiguous-prefix flush (triggered by the next arrival or a
 *      terminal event) drains the buffer in sequence order.
 */
export async function ingestRunEvent(input: IngestRunEventInput): Promise<IngestOutcome> {
  const { run, envelope, webhookId } = input;

  // 1. Replay check — SET … EX … NX atomically rejects a duplicate webhook-id.
  const replayKey = `${REPLAY_KEY_PREFIX}${run.id}:${webhookId}`;
  const cache = await getCache();
  const claimed = await cache.set(replayKey, "1", {
    ttlSeconds: getEnv().REMOTE_RUN_REPLAY_WINDOW_SECONDS,
    nx: true,
  });
  if (!claimed) {
    return { status: "replay" };
  }

  const event = envelopeToRunEvent(envelope, run.id);
  const sequence = envelope.sequence;

  // 2. Fast path: contiguous sequence.
  if (sequence === run.lastEventSequence + 1) {
    await persistEventAndAdvance(run, event, sequence);
    // Attempt to drain any buffered successors while we're here.
    await drainBufferedEvents(run);
    return { status: "persisted", sequence };
  }

  // Already-seen sequence → idempotent ack, no-op.
  if (sequence <= run.lastEventSequence) {
    return { status: "replay" };
  }

  // 3. Out of order — buffer.
  await bufferEvent(run.id, sequence, event);

  // Terminal events flush unconditionally (accept gaps).
  if (TERMINAL_EVENT_TYPES.has(event.type)) {
    await drainBufferedEvents(run, { allowGaps: true });
    return { status: "persisted", sequence };
  }

  return { status: "buffered", sequence };
}

/**
 * Terminal closure — the single convergence point for every run, regardless of
 * origin (platform container, remote CLI, GitHub Action, ...). All post-run
 * logic lives here:
 *
 *   1. Drain buffered events (accepting gaps — last chance).
 *   2. Load the package manifest (for output-schema validation).
 *   3. Derive the authoritative terminal status:
 *        a. Explicit `result.status` from the runner wins.
 *        b. `result.error` → failed.
 *        c. If status is still "success": validate output against manifest
 *           schema (if declared) — failure overrides to "failed".
 *        d. If status is still "success": apply the "zero tokens" heuristic
 *           (no LLM roundtrip ever happened) — overrides to "failed".
 *   4. Build the result payload (`{ output }`) mirroring the legacy
 *      platform shape; consumers of `runs.result` get the same structure
 *      whether the run executed in-process or came from a remote runner.
 *   5. Fire the `afterRun` hook to collect module-provided metadata (billing,
 *      usage quotas, ...).
 *   6. CAS-update the run row (status, result, cost, metadata,
 *      sink_closed_at). Idempotent: zero rows affected = already finalized.
 *   7. Persist memories + checkpoint into the unified store + terminal log rows.
 *   8. Emit `onRunStatusChange` (modules react asynchronously).
 *
 * Idempotent by CAS on `sink_closed_at IS NULL`: concurrent finalize retries
 * from HttpSink end up applying once.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  const { run, result } = input;
  const scope = { orgId: run.orgId, applicationId: run.applicationId };

  // 1. Flush any buffered events before we close the sink.
  await drainBufferedEvents(run, { allowGaps: true });

  // 2. Load manifest for output-schema validation. `includeEphemeral: true`
  //    keeps inline-run shadow packages addressable here.
  const agent = await getPackage(run.packageId, run.orgId, { includeEphemeral: true });

  // 3. Derive final status + error message. Pure computation — no DB writes
  //    before the CAS so concurrent synthesis + container-posted finalize
  //    don't duplicate log rows or memories.
  let status = mapTerminalStatus(result);
  let errorMessage: string | null = result.error?.message ?? null;
  let outputValidationErrors: string[] | null = null;

  if (status === "success" && agent?.manifest.output?.schema) {
    const outputRecord = isPlainRecord(result.output) ? result.output : {};
    const validation = validateOutput(
      outputRecord,
      asJSONSchemaObject(agent.manifest.output.schema),
    );
    if (!validation.valid) {
      status = "failed";
      errorMessage = `Output validation failed: ${validation.errors.join("; ")}`;
      outputValidationErrors = validation.errors;
    }
  }

  if (status === "success") {
    const zeroTokens = await runHadZeroTokens(run.id, result);
    if (zeroTokens) {
      status = "failed";
      errorMessage = llmUnreachableMessage(run);
    }
  }

  // 4. Build the persisted result payload — matches the legacy platform shape
  //    so existing consumers of `runs.result.output` keep working.
  const resultPayload: Record<string, unknown> = {};
  if (result.output !== null && result.output !== undefined) {
    resultPayload.output = result.output;
  }
  const resultToPersist =
    Object.keys(resultPayload).length > 0 ? (resultPayload as Record<string, unknown>) : null;

  // 4b. Write the runner-source ledger row from `result.cost` when the
  //     `appstrate.metric` event never landed (e.g. process exited
  //     before the fire-and-forget POST resolved). The metric handler
  //     and this fallback both target the same partial unique index
  //     (run_id WHERE source='runner'); whichever lands first owns the
  //     row, the other is a no-op via ON CONFLICT DO NOTHING. The
  //     pre-check avoids an insert attempt when we already know the
  //     row is there.
  if (typeof result.cost === "number" && result.cost > 0) {
    const alreadyWritten = await hasRunnerLedgerRow(run.id);
    if (!alreadyWritten) {
      await writeRunnerLedgerRow({ orgId: run.orgId, applicationId: run.applicationId }, run.id, {
        cost: result.cost,
        usage: result.usage ?? null,
      });
    }
  }

  const cost = await computeRunCost(run.id);
  const now = new Date();
  const packageEphemeral = isInlineShadowPackageId(run.packageId);
  // Wall-clock duration as the authoritative value. Runners (PiRunner,
  // MockRunner, …) only measure their internal loop and often omit
  // `durationMs` from the finalize payload — without this fallback the
  // `duration` column stays null on every successful run and the UI
  // loses the value the moment `isRunning` flips to false.
  const resolvedDurationMs = result.durationMs ?? now.getTime() - run.startedAt.getTime();

  // 5. afterRun hook — the hook SHOULD be idempotent (callers may retry on
  //    transient failures) so it runs before the CAS. Any metadata it
  //    returns is included atomically in the same UPDATE.
  // Forward `runs.model_source` so the `afterRun` hook can distinguish
  // platform-paid runs (system models) from BYOK runs (org models) without
  // a re-query. Cloud's billing handler keys credit recording on this —
  // omitting the field made it silently bill every run as `"system"`.
  const hookParams: RunStatusChangeParams = {
    orgId: run.orgId,
    runId: run.id,
    packageId: run.packageId,
    applicationId: run.applicationId,
    status,
    packageEphemeral,
    duration: resolvedDurationMs,
    ...(cost.total > 0 ? { cost: cost.total } : {}),
    ...(run.modelSource !== null ? { modelSource: run.modelSource } : {}),
  };
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = (await callHook("afterRun", hookParams)) ?? null;
  } catch (err) {
    logger.error("afterRun hook failed on remote run finalize", {
      runId: run.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. CAS close — single gate for all subsequent side effects. Concurrent
  //    finalize retries (platform synthesis vs container POST) hit the same
  //    row; the CAS lets exactly one proceed.
  const checkpointSlot = result.pinned?.[CHECKPOINT_KEY];
  const checkpointToPersist =
    checkpointSlot !== undefined && isPlainRecord(checkpointSlot.content)
      ? checkpointSlot.content
      : null;

  const rowsAffected = await db
    .update(runs)
    .set({
      status,
      result: resultToPersist,
      error: errorMessage,
      completedAt: now,
      duration: resolvedDurationMs,
      cost: cost.total > 0 ? cost.total : null,
      sinkClosedAt: now,
      notifiedAt: now,
      // Per-run checkpoint snapshot — read by `getRecentRuns` to feed the
      // sidecar `run_history` tool. The unified `package_persistence`
      // store only keeps the latest checkpoint per actor (last-write-wins
      // on the unique index); `runs.checkpoint` preserves the per-run
      // history so agents can inspect what each prior run emitted.
      ...(checkpointToPersist !== null ? { checkpoint: checkpointToPersist } : {}),
      // When the runner ships authoritative usage in the finalize body
      // we persist it here so `runs.tokenUsage` reflects reality even if
      // the side-channel `appstrate.metric` event was dropped (network
      // hiccup, container exit before the POST drained, …). The metric
      // handler still runs the same UPDATE on its own path; whichever
      // arrives second is a no-op overwrite of the same value.
      ...(result.usage ? { tokenUsage: result.usage as unknown as Record<string, unknown> } : {}),
      ...(metadata ? { metadata } : {}),
    })
    .where(and(eq(runs.id, run.id), sql`sink_closed_at IS NULL`))
    .returning({ id: runs.id });

  if (rowsAffected.length === 0) {
    logger.debug("finalizeRun idempotent — sink already closed", { runId: run.id });
    return;
  }

  // 7. Side effects — only the CAS winner reaches here, so memories and
  //    log rows are written exactly once.
  if (outputValidationErrors) {
    await appendRunLog(
      scope,
      run.id,
      "system",
      "output_validation",
      null,
      { valid: false, errors: outputValidationErrors },
      "error",
    );
  }

  // Resolve the run's actor for the unified persistence scope.
  const [actorRow] = await db
    .select({
      dashboardUserId: runs.dashboardUserId,
      endUserId: runs.endUserId,
    })
    .from(runs)
    .where(eq(runs.id, run.id))
    .limit(1);
  const persistenceScope = scopeFromActor(
    actorFromIds(actorRow?.dashboardUserId ?? null, actorRow?.endUserId ?? null),
  );

  if (result.memories?.length) {
    // Split memories by declared scope and write each non-empty bucket
    // to the unified store. The store IS the store — exceptions
    // propagate so finalize fails loudly on persistence faults.
    const sharedContent: string[] = [];
    const actorContent: string[] = [];
    for (const m of result.memories) {
      if (m.scope === "shared") sharedContent.push(m.content);
      else actorContent.push(m.content);
    }

    if (actorContent.length > 0) {
      await addUnifiedMemories(
        run.packageId,
        run.applicationId,
        run.orgId,
        persistenceScope,
        actorContent,
        run.id,
      );
    }
    if (sharedContent.length > 0) {
      await addUnifiedMemories(
        run.packageId,
        run.applicationId,
        run.orgId,
        { type: "shared" },
        sharedContent,
        run.id,
      );
    }
  }

  // Unified-persistence pinned-slot write — the single store for every
  // named pinned slot the agent wrote via `pin({ key, content })`,
  // including the carry-over `"checkpoint"` slot. Honors the AFPS 1.4
  // scope when the runtime stamped one onto each slot; falls back to
  // the run's actor scope.
  if (result.pinned) {
    for (const [key, slot] of Object.entries(result.pinned)) {
      const slotScope = slot.scope === "shared" ? { type: "shared" as const } : persistenceScope;
      await upsertPinned(
        run.packageId,
        run.applicationId,
        run.orgId,
        slotScope,
        key,
        slot.content,
        run.id,
      );
    }
  }
  if (status === "success" && resultToPersist) {
    await appendRunLog(scope, run.id, "result", "result", null, resultToPersist, "info");
  }
  await appendRunLog(
    scope,
    run.id,
    "system",
    "run_completed",
    null,
    { runId: run.id, status, ...(errorMessage ? { error: errorMessage } : {}) },
    status === "success" ? "info" : "error",
  );

  // 8. Status-change broadcast with the enriched params (including
  //    validation-failure errors and any afterRun metadata).
  const broadcastParams: RunStatusChangeParams = {
    ...hookParams,
    ...(errorMessage ? { extra: { error: errorMessage } } : {}),
    ...(resultToPersist && status === "success" ? { extra: { result: resultToPersist } } : {}),
  };
  void emitEvent("onRunStatusChange", broadcastParams);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether the run produced any LLM tokens. Used as a post-run
 * liveness signal — a run that exited "successfully" without consuming
 * tokens never reached an LLM and is treated as a failure.
 *
 * Resolution order:
 *
 *   1. `result.usage` from the finalize POST body — authoritative when
 *      present. Self-contained: no dependency on the side-channel
 *      `appstrate.metric` event having been ingested first, so the
 *      previous race window (metric POST and finalize POST in flight
 *      simultaneously → finalize reads stale `runs.tokenUsage` = 0 →
 *      false "could not reach the LLM API" failure) is closed.
 *
 *   2. Fallback: the `runs.tokenUsage` JSONB column written by the
 *      `appstrate.metric` event handler. Kept for runners (legacy CLI
 *      paths, third-party AFPS runners) that do not set `result.usage`
 *      and rely on the metric event being ingested before finalize.
 */
async function runHadZeroTokens(runId: string, result: RunResult): Promise<boolean> {
  if (result.usage) {
    return (result.usage.input_tokens ?? 0) === 0 && (result.usage.output_tokens ?? 0) === 0;
  }
  const [row] = await db
    .select({ tokenUsage: runs.tokenUsage })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row?.tokenUsage) return true;
  const usage = row.tokenUsage as Partial<TokenUsage>;
  return (usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0;
}

function llmUnreachableMessage(run: RunSinkContext): string {
  // Runs that carry a `proxyLabel` resolved a proxy at preflight — when they
  // subsequently fail to reach the LLM, the proxy is the first suspect. Keep
  // the two wordings separate so operators can spot which failure mode applies.
  // `run.proxyLabel` isn't in the sink context; we'd need a query. Scoping the
  // message to a single generic reason keeps finalize transport-agnostic.
  void run;
  return "The AI agent could not reach the LLM API — check that the API key is valid and the provider is accessible";
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function envelopeToRunEvent(envelope: CloudEventEnvelope, runId: string): RunEvent {
  // The envelope's `data` field carries the event's non-metadata properties.
  // Rehydrate by merging with the envelope-provided metadata (runId, type,
  // timestamp). `toolCallId` may or may not be present in data — we copy it
  // through untouched.
  return {
    type: envelope.type,
    runId,
    timestamp: Date.parse(envelope.time),
    ...envelope.data,
  } as RunEvent;
}

async function persistEventAndAdvance(
  run: RunSinkContext,
  event: RunEvent,
  sequence: number,
): Promise<void> {
  // Dispatch first; advance the counter only on success so a crashing handler
  // lets the same event retry (deduped via replay cache if already acked).
  const sink = new PersistingEventSink({
    scope: { orgId: run.orgId, applicationId: run.applicationId },
    runId: run.id,
    // The metric event handler is one of the two writers of the
    // runner-source ledger row (the other is the finalize fallback).
    writeLedger: true,
  });
  await sink.handle(event);

  // The very first event a runner posts is the "run is live" signal. No
  // runner currently emits `run.started` (see AppstrateEventSink handlers
  // and HttpSink — neither produces it), so keying the flip on event type
  // would leave remote runs stuck at `pending` until finalize. Instead we
  // flip on the first ingested sequence, whatever its type. Terminal
  // status remains the exclusive responsibility of finalizeRun.
  if (run.lastEventSequence === 0) {
    await updateRun({ orgId: run.orgId, applicationId: run.applicationId }, run.id, {
      status: "running",
    });
  }

  // Advance the sequence counter AND bump the liveness marker in a single
  // UPDATE. Every authenticated event is an implicit heartbeat — the
  // watchdog uses `last_heartbeat_at` as the single source of truth for
  // stall detection, regardless of runner topology. The CAS on the
  // previous sequence keeps the advance no-op if a parallel flush beat us,
  // but the heartbeat bump is still safe: a concurrent event POST is,
  // by definition, proof-of-life.
  await db
    .update(runs)
    .set({ lastEventSequence: sequence, lastHeartbeatAt: new Date() })
    .where(and(eq(runs.id, run.id), eq(runs.lastEventSequence, sequence - 1)));
  // Keep the in-memory context fresh for the rest of the request.
  run.lastEventSequence = sequence;
}

async function bufferEvent(runId: string, sequence: number, event: RunEvent): Promise<void> {
  const buffer = await getEventBuffer();
  const ttlSeconds = Math.ceil(getEnv().REMOTE_RUN_BUFFER_FLUSH_MS / 1000) + 60;
  await buffer.put(runId, sequence, event, ttlSeconds);
}

async function drainBufferedEvents(
  run: RunSinkContext,
  opts: { allowGaps?: boolean } = {},
): Promise<void> {
  const buffer = await getEventBuffer();

  while (true) {
    const head = await buffer.peekLowest(run.id);
    if (!head) return;

    const next = run.lastEventSequence + 1;

    if (head.sequence === next) {
      await persistEventAndAdvance(run, head.event, head.sequence);
      await buffer.remove(run.id, head.sequence);
      continue;
    }

    if (opts.allowGaps && head.sequence > next) {
      // Skip the gap — persist the lowest buffered event as if it were the
      // next in line. Records a gap-filling log line so operators can spot
      // dropped events in post-mortems.
      logger.warn("remote run flushed with sequence gap", {
        runId: run.id,
        expectedSequence: next,
        actualSequence: head.sequence,
      });
      await persistEventAndAdvance(run, head.event, head.sequence);
      await buffer.remove(run.id, head.sequence);
      continue;
    }

    return; // Gap at the head and gaps not allowed — wait for the missing event.
  }
}

function mapTerminalStatus(result: RunResult): "success" | "failed" | "timeout" | "cancelled" {
  // Explicit status wins — runner-provided terminal cause (timeout,
  // cancellation) is authoritative over inference from `error`.
  if (result.status) return result.status;
  return result.error ? "failed" : "success";
}

// notFound is imported for symmetry with gone() — callers (the middleware)
// map null lookups to 404. Exported so the middleware has a single source.
export { notFound };
