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
 *   - {@link finalizeRemoteRun}   — terminal RunResult → flush buffer → close
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
import { getRedisConnection } from "../lib/redis.ts";
import { getEnv } from "@appstrate/env";
import { AppstrateEventSink } from "./adapters/appstrate-event-sink.ts";
import { updateRun } from "./state/runs.ts";
import { callHook, emitEvent } from "../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "./inline-run.ts";
import type { RunStatusChangeParams } from "@appstrate/core/module";
import { aggregateRunCost } from "./credential-proxy-usage.ts";
import { assertSinkOpen, verifyRunSignatureHeaders } from "../lib/run-signature.ts";

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

export interface FinalizeRemoteRunInput {
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

/** Redis key prefix for webhook-id dedup (replay cache). */
const REPLAY_KEY_PREFIX = "appstrate:remote-run:replay:";
/** Redis key prefix for per-run ordering buffer (sorted set keyed by sequence). */
const BUFFER_KEY_PREFIX = "appstrate:remote-run:buffer:";

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
  const redis = getRedisConnection();
  const setResult = await redis.set(
    replayKey,
    "1",
    "EX",
    getEnv().REMOTE_RUN_REPLAY_WINDOW_SECONDS,
    "NX",
  );
  if (setResult === null) {
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
 * Terminal closure.
 *
 * Idempotent by CAS on `sink_closed_at IS NULL`: concurrent finalize requests
 * (retries from an HttpSink that didn't see our 200) end up applying once.
 *
 * Order:
 *   1. Flush buffered events (accepting gaps — we will never see them now).
 *   2. CAS-update the run row with status + result + cost.
 *   3. Fire `afterRun` hook and `onRunStatusChange` event.
 */
export async function finalizeRemoteRun(input: FinalizeRemoteRunInput): Promise<void> {
  const { run, result } = input;

  // 1. Drain buffer (no gap filtering — this is the last chance).
  await drainBufferedEvents(run, { allowGaps: true });

  // 2. CAS close. Zero rows affected → already finalized, return 200.
  const cost = await aggregateRunCost(run.id);
  const now = new Date();
  const status = mapTerminalStatus(result);

  // Usage is accumulated in-place by AppstrateEventSink's metric handler as
  // `appstrate.metric` events arrived — no need to re-write it here. Cost is
  // the aggregated proxy-attributable spend (llm + credential) which may
  // include rows whose run_id matches but whose insertion races the final
  // event; re-computed here as the authoritative close-out value.
  const rowsAffected = await db
    .update(runs)
    .set({
      status,
      // output is runtime's unknown|null; Drizzle jsonb accepts unknown but
      // the column type is Record<string, unknown> — the cast is intentional
      // and matches how existing code persists arbitrary output shapes.
      result: (result.output ?? null) as Record<string, unknown> | null,
      error: result.error ? result.error.message : null,
      completedAt: now,
      duration: result.durationMs ?? null,
      cost: cost.total,
      sinkClosedAt: now,
    })
    .where(and(eq(runs.id, run.id), sql`sink_closed_at IS NULL`))
    .returning({ id: runs.id });

  if (rowsAffected.length === 0) {
    logger.debug("finalizeRemoteRun idempotent — sink already closed", { runId: run.id });
    return;
  }

  // 3. Hooks.
  const packageEphemeral = isInlineShadowPackageId(run.packageId);
  const hookParams: RunStatusChangeParams = {
    orgId: run.orgId,
    runId: run.id,
    packageId: run.packageId,
    applicationId: run.applicationId,
    status,
    packageEphemeral,
  };

  try {
    await callHook("afterRun", hookParams);
  } catch (err) {
    logger.error("afterRun hook failed on remote run finalize", {
      runId: run.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  void emitEvent("onRunStatusChange", hookParams);
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
  const sink = new AppstrateEventSink({
    scope: { orgId: run.orgId, applicationId: run.applicationId },
    runId: run.id,
  });
  await sink.handle(event);

  // Status transitions are route-layer; the data-plane never mutates run
  // status. `run.started` flips pending → running so the dashboard shows
  // the run is live; terminal status is set exclusively by finalizeRemoteRun.
  if (event.type === "run.started") {
    await updateRun({ orgId: run.orgId, applicationId: run.applicationId }, run.id, {
      status: "running",
    });
  }

  // Advance the sequence counter (CAS — no-op if another flush beat us).
  await db
    .update(runs)
    .set({ lastEventSequence: sequence })
    .where(and(eq(runs.id, run.id), eq(runs.lastEventSequence, sequence - 1)));
  // Keep the in-memory context fresh for the rest of the request.
  run.lastEventSequence = sequence;
}

async function bufferEvent(runId: string, sequence: number, event: RunEvent): Promise<void> {
  const redis = getRedisConnection();
  const key = `${BUFFER_KEY_PREFIX}${runId}`;
  // Sorted set with sequence as score; payload as member (JSON-encoded).
  await redis.zadd(key, sequence, JSON.stringify(event));
  // Expiry anchored to buffer flush window + a safety margin.
  await redis.expire(key, Math.ceil(getEnv().REMOTE_RUN_BUFFER_FLUSH_MS / 1000) + 60);
}

async function drainBufferedEvents(
  run: RunSinkContext,
  opts: { allowGaps?: boolean } = {},
): Promise<void> {
  const redis = getRedisConnection();
  const key = `${BUFFER_KEY_PREFIX}${run.id}`;

  while (true) {
    // ZRANGE … WITHSCORES returns [member1, score1, member2, score2, ...].
    const pair = await redis.zrange(key, 0, 0, "WITHSCORES");
    if (pair.length === 0) return;

    const member = pair[0]!;
    const score = Number(pair[1]!);
    const next = run.lastEventSequence + 1;

    if (score === next) {
      const event = JSON.parse(member) as RunEvent;
      await persistEventAndAdvance(run, event, score);
      await redis.zrem(key, member);
      continue;
    }

    if (opts.allowGaps && score > next) {
      // Skip the gap — persist the lowest buffered event as if it were the
      // next in line. Records a gap-filling log line so operators can spot
      // dropped events in post-mortems.
      logger.warn("remote run flushed with sequence gap", {
        runId: run.id,
        expectedSequence: next,
        actualSequence: score,
      });
      const event = JSON.parse(member) as RunEvent;
      await persistEventAndAdvance(run, event, score);
      await redis.zrem(key, member);
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
