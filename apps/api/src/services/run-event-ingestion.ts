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
 *                                   sink → onRunStatusChange broadcast
 *
 * Invariant: `appendRunLog()` and status-lifecycle updates have **exactly one**
 * caller chain, rooted here. `AppstrateEventSink.handle()` is instantiated
 * inside `ingestRunEvent`; it is never called from anywhere else.
 *
 * This file is the full design — there is no `docs/specs/` directory in this
 * repo. Its transport half lives in `routes/runs-events.ts`.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, TERMINAL_RUN_EVENT_TYPES, type RunResultPayload } from "@appstrate/db/schema";
import { type CloudEventEnvelope } from "@appstrate/afps-runtime/events";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { emptyRunResult, type RunResult } from "@appstrate/afps-runtime/runner";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import { getCache, getEventBuffer } from "../infra/index.ts";
import { getEnv } from "@appstrate/env";
import {
  runWithSpan,
  recordRunDuration,
  recordRunTerminal,
  recordFilePartialPublication,
} from "@appstrate/core/telemetry";
import { persistRunEvent, writeRunnerLedgerRow } from "./run-launcher/appstrate-event-sink.ts";
import {
  updateRun,
  appendRunLog,
  computeRunSpend,
  readLastEmittedOutput,
  runAgentIdentity,
} from "./state/runs.ts";
import { createRunNotifications } from "./state/notifications.ts";
import {
  addMemories as addUnifiedMemories,
  upsertPinned,
  scopeFromActor,
  CHECKPOINT_KEY,
} from "./state/package-persistence.ts";
import { actorFromIds } from "../lib/actor.ts";
import { getRunEffectiveAgent, runPinnedVersionGoneDetail } from "./run-effective-agent.ts";
import { validateOutput } from "./schema.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { emitEvent } from "../lib/modules/module-loader.ts";
import { isInlineShadowPackageId } from "./inline-run.ts";
import type { RunStatusChangeParams } from "@appstrate/core/module";
import { assertSinkOpen, verifyRunSignatureHeaders } from "../lib/run-signature.ts";
import { gone } from "@appstrate/core/api-errors";
import { clearRunMetricBroadcastState } from "./run-metric-broadcaster.ts";
import { runWorkspaceDeletionJobs } from "./run-workspace-storage.ts";
import { enqueueStorageDeletion } from "./storage-deletion.ts";
import { runResultSchema } from "../lib/jsonb-schemas.ts";
import { tokenUsageSchema } from "@appstrate/core/token-usage";
import type { TokenUsage } from "@appstrate/shared-types";

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
import type { RunSinkContext } from "../types/run-sink.ts";

type IngestOutcome =
  | { status: "persisted"; sequence: number }
  | { status: "replay" }
  | { status: "buffered"; sequence: number };

interface IngestRunEventInput {
  run: RunSinkContext;
  envelope: CloudEventEnvelope;
  webhookId: string;
}

interface FinalizeRunInput {
  run: RunSinkContext;
  result: RunResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Key prefix for webhook-id replay dedup. */
const REPLAY_KEY_PREFIX = "appstrate:remote-run:replay:";

/**
 * Operator-facing message for the "LLM never reachable" failure shape —
 * a run that produced zero tokens (see {@link runHadZeroTokens}). Distinct
 * from a terminal model error the runner already stamped: that verdict is
 * the runner's authoritative call (runner-pi's `getTerminalError()`), and
 * finalize no longer scans the `run_logs` adapter-error trail at all.
 *
 * One generic reason on purpose, so finalize stays transport-agnostic: the
 * proxy a run resolved at preflight is not in the sink context, and naming it
 * would cost a query for a message nobody can act on differently.
 */
const LLM_UNREACHABLE_MESSAGE =
  "The AI agent could not reach the LLM API — check that the API key is valid and the provider is accessible";

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
      spaceId: runs.spaceId,
      packageId: runs.packageId,
      agentScope: runs.agentScope,
      agentName: runs.agentName,
      runOrigin: runs.runOrigin,
      sinkSecretEncrypted: runs.sinkSecretEncrypted,
      sinkExpiresAt: runs.sinkExpiresAt,
      sinkClosedAt: runs.sinkClosedAt,
      lastEventSequence: runs.lastEventSequence,
      startedAt: runs.startedAt,
      versionRef: runs.versionRef,
      modelSource: runs.modelSource,
      modelCost: runs.modelCost,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!row) return null;
  if (row.sinkSecretEncrypted === null) return null;

  // `RunSinkContext.packageId` is typed as a non-null string, so a raw
  // `row as RunSinkContext` cast would smuggle a runtime null past every
  // finalize consumer (getRunEffectiveAgent, memory/pinned persistence,
  // onRunStatusChange event params) — silently skipping finalization
  // side-effects for a deleted-agent run. `runAgentIdentity` owns the recovery
  // (and the sentinel); see `state/runs.ts`.
  const { agentScope, agentName, ...rest } = row;
  const packageId = runAgentIdentity({ ...rest, agentScope, agentName });
  return { ...rest, packageId } as RunSinkContext;
}

// `assertSinkOpen` and `verifyRunSignatureHeaders` live in
// `../lib/run-signature.ts` and are re-exported at the top of this file.
// Pulling them out of this module keeps the signature-verification unit
// tests from requiring the db client's env invariants.

/**
 * Re-read `runs.last_event_sequence` from the DB and, if it advanced past
 * the caller's in-memory snapshot, update `run.lastEventSequence` in place.
 * Returns whether the value advanced.
 *
 * Concurrent POSTs each load their own snapshot in the verify-signature
 * middleware before any of them persists, so a parallel burst sees the
 * same stale value: only one wins the fast-path CAS, the others observe a
 * false gap-at-head. Refreshing from DB lets the loser's drain recompute
 * `next` against actual DB state instead of stranding buffered events
 * until finalize's gap_fill.
 */
async function refreshSequence(run: RunSinkContext): Promise<boolean> {
  const [fresh] = await db
    .select({ s: runs.lastEventSequence })
    .from(runs)
    .where(eq(runs.id, run.id))
    .limit(1);
  if (fresh && fresh.s > run.lastEventSequence) {
    run.lastEventSequence = fresh.s;
    return true;
  }
  return false;
}

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
  if (!claimed) return { status: "replay" };

  try {
    return await ingestInner(run, envelope);
  } catch (err) {
    // Release the replay key so the runner's retry (same webhook-id, fresh
    // attempt over the wire) is not silently absorbed by the replay check.
    // Best-effort: a failed DEL leaves the key sticky for `replayWindow`
    // seconds — strictly worse than success but no worse than the
    // pre-cleanup baseline. The original error wins regardless.
    await cache.del(replayKey).catch(() => {});
    throw err;
  }
}

async function ingestInner(
  run: RunSinkContext,
  envelope: CloudEventEnvelope,
): Promise<IngestOutcome> {
  const event = envelopeToRunEvent(envelope, run.id);
  const sequence = envelope.sequence;

  // 2. Fast path: contiguous sequence.
  if (sequence === run.lastEventSequence + 1) {
    const outcome = await persistEventAndAdvance(run, event, sequence);
    if (outcome === "sink_closed") {
      // The middleware's `assertSinkOpen` snapshot passed but finalize won
      // the race before the CAS committed. Surface the same 410 wire code
      // the snapshot check uses — distinct from a sequence lost-race (which
      // stays an idempotent 200) so runner retry semantics stay correct:
      // 410 means "stop sending", not "resend".
      throw gone("run_sink_closed", `run ${run.id} sink was closed while the event was in flight`);
    }
    await drainBufferedEvents(run);
    return { status: "persisted", sequence };
  }

  // Already-seen sequence → idempotent ack, no-op.
  if (sequence <= run.lastEventSequence) return { status: "replay" };

  // 3. Out of order — buffer.
  await bufferEvent(run.id, sequence, event);

  // Terminal events flush unconditionally (accept gaps).
  if (TERMINAL_RUN_EVENT_TYPES.has(event.type)) {
    await drainBufferedEvents(run, { allowGaps: true });
    return { status: "persisted", sequence };
  }

  // Refresh the in-memory snapshot from DB and try a drain. Without this
  // refresh + drain attempt, buffered events sit until finalize's gap_fill
  // — collapsing real-time activity into a single visual burst.
  await refreshSequence(run);
  await drainBufferedEvents(run);

  return run.lastEventSequence >= sequence
    ? { status: "persisted", sequence }
    : { status: "buffered", sequence };
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
 *   5. Build the terminal params shared by the CAS and the broadcast.
 *   6. CAS-update the run row (status, result, cost, sink_closed_at).
 *      Idempotent: zero rows affected = already finalized.
 *   7. Persist memories + checkpoint into the unified store + terminal log
 *      rows, then emit `onRunStatusChange` (modules react asynchronously).
 *
 * Idempotent by CAS on `sink_closed_at IS NULL`: concurrent finalize retries
 * from HttpSink end up applying once.
 */
export async function finalizeRun(input: FinalizeRunInput): Promise<void> {
  // Finalize span — the single CAS-guarded convergence for every run
  // termination path. Nests under the active request/run span when present.
  // A true no-op when observability is disabled.
  try {
    await runWithSpan(
      "appstrate.run.finalize",
      { attributes: { "appstrate.run.id": input.run.id } },
      () => finalizeRunImpl(input),
    );
  } finally {
    // Single, unconditional release point for the run's in-memory metric
    // throttle entry. `finalizeRunImpl` has many exits (idempotent no-op when
    // the sink is already closed, the CAS-winner path, and any throw from the
    // post-CAS side effects); dropping the entry here covers all of them,
    // including the throwing ones that previously leaked it for the lifetime
    // of the process. Also runs AFTER the post-CAS side effects, so a metric
    // event racing them cannot re-create an entry that nothing then clears.
    //
    // Local-only by construction: the entry lives on whichever replica
    // ingested the metric event, which is not necessarily the one handling
    // `/finalize`. The broadcaster's own idle sweep is what bounds that case.
    clearRunMetricBroadcastState(input.run.id);
  }
}

async function finalizeRunImpl(input: FinalizeRunInput): Promise<void> {
  const { run, result } = input;
  const scope = { orgId: run.orgId, spaceId: run.spaceId };

  // 1. Flush any buffered events before we close the sink.
  await drainBufferedEvents(run, { allowGaps: true });

  // 2. Load the manifest of the definition the run EXECUTED for output-schema
  //    validation — the pinned `package_versions` snapshot when `version_ref`
  //    names one, the draft otherwise. Validating against the mutable draft
  //    let a post-kickoff schema edit flip a pinned run's outcome (false
  //    failure on a tightened draft schema, false success on a loosened one).
  const effective = await getRunEffectiveAgent(run);

  // 3. Derive final status + error message. Pure computation — no DB writes
  //    before the CAS so concurrent synthesis + container-posted finalize
  //    don't duplicate log rows or memories.
  let status = mapTerminalStatus(result);
  let errorMessage: string | null = result.error?.message ?? null;
  let outputValidationErrors: string[] | null = null;

  if (effective.status === "version_deleted") {
    // The pinned `package_versions` snapshot was deleted mid-run while the
    // agent itself still exists, so the output contract this run agreed to
    // cannot be read. Optional chaining here used to skip validation entirely
    // and let the run land on `success` — a verdict rendered against a contract
    // nobody read. Fail it instead, naming the same cause the run-token guards
    // name. Only a `success` verdict is rewritten: a run that already terminated
    // non-success carries its own, more specific cause (watchdog kill,
    // cancellation, runner-declared failure) and must keep it.
    if (status === "success") {
      status = "failed";
      errorMessage = runPinnedVersionGoneDetail(effective);
    }
  } else if (effective.status === "agent_deleted") {
    // Deliberately NOT the branch above, and deliberately not a failure:
    // `agent_deleted` is a designed state (see `runAgentIdentity` in
    // `state/runs.ts`). Failing the run here would fabricate a verdict about
    // work that may have completed fine, so the runner's own status stands.
  } else if (status === "success" && effective.manifest.output?.schema) {
    // Distinguish two failure shapes that both surface as a schema mismatch:
    //   1. the agent never called `output` (`result.output` is null) — the
    //      empty `{}` only fails because required fields are absent, so a bare
    //      "validation failed" message misleads (it reads as a malformed
    //      payload when the tool was simply never invoked);
    //   2. the agent called `output` with a payload that violates the schema.
    // A schema with no required fields still validates an empty `{}` as valid,
    // so a side-effect-only run (output schema, nothing required) stays success
    // in both branches — only the error string differs.
    const outputEmitted = isPlainRecord(result.output);
    const outputRecord = isPlainRecord(result.output) ? result.output : {};
    const validation = validateOutput(
      outputRecord,
      asJSONSchemaObject(effective.manifest.output.schema),
    );
    if (!validation.valid) {
      status = "failed";
      // Every run delivers structured output through the `output` runtime
      // tool (the single Pi-engine channel).
      const missing = validation.errors.join("; ");
      errorMessage = outputEmitted
        ? `Output validation failed: ${missing}`
        : `Agent finished without calling the required \`output\` tool. This agent ` +
          `declares an output schema, so it must call \`output\` exactly once before ` +
          `finishing with all required fields (missing: ${missing}).`;
      outputValidationErrors = validation.errors;
    }
  }

  // NOTE: terminal success/failure is the RUNNER's call, not the
  // platform's. `PiRunner.run()` inspects the settled session and stamps
  // `status: "failed"` + `error` when the agent loop ended on an errored
  // final turn (see the bridge's `getTerminalError()` in runner-pi); a
  // transient mid-loop error the
  // agent recovered from leaves `status: "success"`. `mapTerminalStatus`
  // honours that authoritative status above. The platform deliberately
  // does NOT second-guess it by scanning the `run_logs` adapter-error
  // trail — that post-hoc archaeology produced false positives, failing
  // runs whose agent recovered and delivered via `report`/`log` (which
  // legitimately leave `output === null`). The `runHadZeroTokens` guard
  // below remains as a distinct backstop for the "LLM never reachable,
  // zero tokens, no terminal error surfaced" shape.

  // Zod boundary on the runner-supplied terminal usage (tolerant: known
  // numeric fields kept, unknown keys stripped). The fallback semantics
  // split on the terminal status:
  //
  //   - SUCCESS: the finalize body is the single source of truth — an
  //     absent/invalid shape becomes explicit zero usage so the zero-token
  //     liveness heuristic below cannot be defeated by a late side-channel
  //     metric event.
  //   - NON-SUCCESS (watchdog kill, container crash, runner-declared
  //     failure without a billing block): the run died before it could
  //     post terminal usage. Coercing to zeros here would ERASE the
  //     last-known cumulative snapshot the `appstrate.metric` side-channel
  //     wrote onto `runs.tokenUsage` during the run — the per-call spend
  //     is already in the `llm_usage` ledger (runner/proxy rows) and the
  //     column is its run-row mirror, so preserve it instead.
  //
  // Preserving that snapshot cannot double-bill — but NOT because preservation
  // skips the ledger. It does write a ledger row: the barrier below is gated on
  // `terminalCost !== null || tokenUsageIsNonZero(...)`, so a preserved snapshot
  // carrying tokens goes through it, and that is exactly how a run that died
  // mid-flight is billed at all.
  //
  // What makes it safe is structural, and holds for any number of writes. A run
  // has at MOST ONE `source="runner"` row (partial unique index
  // `uq_llm_usage_runner_run_id`), and every write is an UPSERT of the run's
  // CUMULATIVE total — never an append of a delta. Re-submitting the snapshot
  // the `appstrate.metric` side channel already wrote is therefore an exact
  // duplicate, which the strict-inequality advance rule discards as a no-op; a
  // smaller one is refused outright. Two writes of the same total bill that
  // total once. Double-counting would need either a second runner row or an
  // additive write, and the ledger offers neither.
  //
  // The other half is ordering, and is unchanged: the CAS on `sink_closed_at`
  // guarantees a terminal usage arriving after this finalize can never re-open
  // the run.
  let validatedUsage = validateFinalizeUsage(result.usage, run.id);
  // Non-success without runner-posted usage: the run-row column must keep
  // whatever cumulative snapshot the `appstrate.metric` side-channel last
  // wrote. The COLUMN preservation happens atomically in the CAS below
  // (SQL COALESCE) — a JS read-then-write here would race a concurrent
  // metric event and clobber a newer snapshot with the stale read. The read
  // below is what the terminal ledger row is PRICED from (`runs.model_cost` ×
  // these counters) — see the barrier below.
  const preserveLastKnownUsage = validatedUsage === null && status !== "success";
  if (preserveLastKnownUsage) {
    validatedUsage = await readLastKnownUsage(run.id);
  }
  if (validatedUsage === null) {
    logger.warn("finalize: missing result.usage; treating as zero-token terminal usage", {
      runId: run.id,
    });
    validatedUsage = { input_tokens: 0, output_tokens: 0 };
  }

  if (status === "success") {
    if (runHadZeroTokens(validatedUsage)) {
      status = "failed";
      errorMessage = LLM_UNREACHABLE_MESSAGE;
    }
  }

  // 4. Build the persisted result payload — structured output only. Anything
  //    the agent means for a human is a durable file (`outputs/` sweep or
  //    `publish_file`), never a field on this row.
  //
  //    Zod boundary on the persisted payload (`runResultSchema`: closed shape,
  //    JSON-safe values, 512 KiB cap). `output` is runner-controlled, so the
  //    validation is tolerant: an invalid payload degrades to `null` + a warn
  //    log (the terminal status, error message and run_logs trail survive) —
  //    it must never fail the finalize of an already-completed run.
  let resultToPersist: RunResultPayload | null = null;
  if (result.output !== null && result.output !== undefined) {
    const parsedResult = runResultSchema.safeParse({ output: result.output });
    if (parsedResult.success) {
      resultToPersist = parsedResult.data;
    } else {
      logger.warn("finalize: dropping invalid runs.result payload", {
        runId: run.id,
        reason: parsedResult.error.issues[0]?.message ?? "validation failed",
      });
    }
  }

  // 4b. TERMINAL LEDGER BARRIER — last point at which this run's runner row can
  //     be written. The CAS below flips the run terminal, which is what makes
  //     the row `settled`: a billing cursor may then claim it by serial id,
  //     once. So anything owed must be durably in Postgres BEFORE the CAS —
  //     hence `required: true`, which keeps the run open for a retry on failure.
  //
  //     Not gated on `result.cost > 0`: every platform-synthesised terminal
  //     (stall watchdog, orphan sweep, crash/timeout/cancel) builds a RunResult
  //     with no `cost`, and those are exactly the runs whose last snapshot is
  //     most in doubt. A run that consumed nothing is still skipped.
  //
  //     The row is priced server-side from `run.modelCost` × the usage passed
  //     here rather than from `result.cost`. It rarely moves the number: the
  //     upsert is monotone, so the metric side-channel's own rows already hold
  //     this run's cost and a lower candidate cannot regress them. What it does
  //     guarantee is a priced row where the container reported no cost at all —
  //     an aliased run, which is never given `MODEL_COST`. See
  //     `resolveRunnerCost`.
  const terminalCost = typeof result.cost === "number" ? result.cost : null;
  if (terminalCost !== null || tokenUsageIsNonZero(validatedUsage)) {
    await writeRunnerLedgerRow(
      { orgId: run.orgId, spaceId: run.spaceId },
      run.id,
      {
        cost: terminalCost,
        usage: validatedUsage,
        modelSource: run.modelSource,
        // Same kickoff snapshot the metric path uses, so the terminal write
        // classifies identically to every snapshot before it.
        modelCost: run.modelCost,
      },
      { required: true },
    );
  }

  // Cost and its provenance are read together, AFTER the barrier above so both
  // see the run's terminal runner row. Caching only the number would leave the
  // UI rendering a confident `$0.0000` for a run nothing could price.
  const { costUsd: cost, pricingStatus: costPricingStatus } = await computeRunSpend(
    run.id,
    run.orgId,
  );
  const now = new Date();
  const packageEphemeral = isInlineShadowPackageId(run.packageId);
  // Wall-clock duration as the authoritative value. Runners (PiRunner,
  // MockRunner, …) only measure their internal loop and often omit
  // `durationMs` from the finalize payload — without this fallback the
  // `duration` column stays null on every successful run and the UI
  // loses the value the moment `isRunning` flips to false.
  const resolvedDurationMs = result.durationMs ?? now.getTime() - run.startedAt.getTime();

  // 5. Terminal params shared by the CAS below and the `onRunStatusChange`
  //    broadcast in step 7. Forwarding `runs.model_source` lets a subscriber
  //    tell platform-paid runs (system models) from BYOK runs (org models)
  //    without a re-query — a metering subscriber keys its recording on it,
  //    and omitting the field made it treat every run as `"system"`.
  const terminalParams: RunStatusChangeParams = {
    orgId: run.orgId,
    runId: run.id,
    packageId: run.packageId,
    spaceId: run.spaceId,
    status,
    packageEphemeral,
    duration: resolvedDurationMs,
    ...(cost > 0 ? { cost } : {}),
    ...(run.modelSource !== null ? { modelSource: run.modelSource } : {}),
  };
  // 6. CAS close — single gate for all subsequent side effects. Concurrent
  //    finalize retries (platform synthesis vs container POST) hit the same
  //    row; the CAS lets exactly one proceed.
  const checkpointSlot = result.pinned?.[CHECKPOINT_KEY];
  const checkpointToPersist =
    checkpointSlot !== undefined && isPlainRecord(checkpointSlot.content)
      ? checkpointSlot.content
      : null;

  // The CAS and the run-workspace teardown enqueue are ONE transaction: the
  // moment a run is durably terminal, the record that purges its provisioning
  // objects is durable too. (The enqueue is a bounded INSERT of two rows and
  // does NO storage I/O — the outbox worker performs the physical deletes — so
  // it adds no latency to the terminal broadcast below.)
  const rowsAffected = await db.transaction(async (tx) => {
    const closed = await tx
      .update(runs)
      .set({
        status,
        result: resultToPersist,
        error: errorMessage,
        completedAt: now,
        duration: resolvedDurationMs,
        cost: cost > 0 ? cost : null,
        // Written even when `cost` is nulled above: a zero cost with an
        // `unpriced` verdict is the whole point — the absence of a number and
        // the absence of PRICING are different facts, and only the second one
        // is a platform gap. Left untouched (NULL) when no ledger row of this
        // run carries a status.
        ...(costPricingStatus !== null ? { costPricingStatus } : {}),
        sinkClosedAt: now,
        // Per-run checkpoint snapshot — read by `getRecentRuns` to feed the
        // sidecar `run_history` tool. The unified `package_persistence`
        // store only keeps the latest checkpoint per actor (last-write-wins
        // on the unique index); `runs.checkpoint` preserves the per-run
        // history so agents can inspect what each prior run emitted.
        ...(checkpointToPersist !== null ? { checkpoint: checkpointToPersist } : {}),
        // Terminal artifacts summary from the container's outputs sweep. Only
        // written when the runner reported it (older containers omit it) — an
        // absent value leaves the column null rather than clobbering it. Does NOT
        // affect `status` above: a `partial` summary coexists with a run success.
        ...(result.artifacts !== undefined ? { artifacts: result.artifacts } : {}),
        // The finalize body is the authoritative terminal usage. Metric events
        // may still update this column before finalize for live charts, but the
        // close path writes the terminal value exactly once. When a non-success
        // terminal carried no usage, the column keeps its last-known snapshot
        // ATOMICALLY (COALESCE evaluates in the UPDATE itself — a metric event
        // landing between the JS read above and this CAS cannot be clobbered
        // by a stale value); zeros only when nothing was ever recorded.
        tokenUsage: preserveLastKnownUsage
          ? sql`COALESCE(${runs.tokenUsage}, ${JSON.stringify({ input_tokens: 0, output_tokens: 0 })}::jsonb)`
          : validatedUsage,
      })
      .where(and(eq(runs.id, run.id), sql`sink_closed_at IS NULL`))
      .returning({ id: runs.id });
    // Only the CAS winner enqueues — a losing retry would re-enqueue keys the
    // winner already queued (deduped by the outbox, but pointless work).
    if (closed.length > 0) {
      await enqueueStorageDeletion(tx, runWorkspaceDeletionJobs(run.id, "run_workspace_deleted"));
    }
    return closed;
  });

  if (rowsAffected.length === 0) {
    logger.debug("finalizeRun idempotent — sink already closed", { runId: run.id });
    return;
  }

  // NOTE: the per-run metric throttle entry is released in `finalizeRun`'s
  // `finally` — one release point covering every exit of this function.

  // SLI emission — exactly-once on the CAS winner. Run-duration histogram +
  // terminal-status counter (the failure-rate source). No-op when disabled.
  recordRunDuration(resolvedDurationMs, { status });
  recordRunTerminal({ status, errorCode: result.error?.code });
  // A partial artifacts summary means the run lost at least one deliverable
  // (over-cap/quota/conflict/upload-failed) — a health signal independent of the
  // run's own terminal status. Emitted on the CAS winner only (exactly-once).
  if (result.artifacts?.status === "partial") recordFilePartialPublication();

  // The run's workspace provisioning archive (the AFPS bundle + input docs the
  // agent fetched at startup) was enqueued for deletion INSIDE the CAS
  // transaction above. finalizeRun is the single CAS-guarded convergence for
  // every termination path — natural finalize, watchdog stall sweep, container-
  // exit synthesis — so the objects are dropped even when the launcher teardown
  // never runs (e.g. the API replica that launched the run crashed). Enqueuing
  // there rather than firing-and-forgetting here is what makes it crash-safe: a
  // SIGKILL (OOM, rolling deploy, eviction) between the commit and this line
  // used to lose the teardown outright — the run is terminal, so
  // `listOrphanRunIds()` never returns it and nothing ever replayed it.

  // 7. Side effects — only the CAS winner reaches here, so memories and
  //    log rows are written exactly once.
  if (outputValidationErrors) {
    // Post-CAS best-effort: the run is already terminal, a transient
    // log INSERT failure must not crash finalize. The validation
    // failure is also surfaced via `runs.error` (CAS update above).
    try {
      await appendRunLog(
        scope,
        run.id,
        "system",
        "output_validation",
        null,
        { valid: false, errors: outputValidationErrors },
        "error",
      );
    } catch (err) {
      logger.error("finalize: appendRunLog output_validation failed", {
        runId: run.id,
        err: getErrorMessage(err),
      });
    }
  }

  // Resolve the run's actor for the unified persistence scope.
  const [actorRow] = await db
    .select({
      userId: runs.userId,
      endUserId: runs.endUserId,
    })
    .from(runs)
    .where(eq(runs.id, run.id))
    .limit(1);
  const persistenceScope = scopeFromActor(
    actorFromIds(actorRow?.userId ?? null, actorRow?.endUserId ?? null),
  );

  // Post-CAS best-effort: the run is already terminal in `runs`. Memory and
  // pinned-slot persistence is agent-authored side-data — a transient store
  // fault here must NOT strand the status-change broadcast below (the only
  // signal that updates the UI / fires webhooks) nor 500 the runner for a run
  // that is already committed terminal. Log + swallow, like the run-log writes
  // further down. (Persistence faults are surfaced via the error log for ops.)
  try {
    if (result.memories?.length) {
      // Split memories by declared scope and write each non-empty bucket.
      const sharedContent: string[] = [];
      const actorContent: string[] = [];
      for (const m of result.memories) {
        if (m.scope === "shared") sharedContent.push(m.content);
        else actorContent.push(m.content);
      }

      if (actorContent.length > 0) {
        await addUnifiedMemories(
          run.packageId,
          run.spaceId,
          run.orgId,
          persistenceScope,
          actorContent,
          run.id,
        );
      }
      if (sharedContent.length > 0) {
        await addUnifiedMemories(
          run.packageId,
          run.spaceId,
          run.orgId,
          { type: "shared" },
          sharedContent,
          run.id,
        );
      }
    }

    // Unified-persistence pinned-slot write — the single store for every
    // named pinned slot the agent wrote via `pin({ key, content })`,
    // including the carry-over `"checkpoint"` slot. Honors the AFPS
    // scope when the runtime stamped one onto each slot; falls back to
    // the run's actor scope.
    if (result.pinned) {
      for (const [key, slot] of Object.entries(result.pinned)) {
        const slotScope = slot.scope === "shared" ? { type: "shared" as const } : persistenceScope;
        await upsertPinned(
          run.packageId,
          run.spaceId,
          run.orgId,
          slotScope,
          key,
          slot.content,
          run.id,
        );
      }
    }
  } catch (err) {
    logger.error("finalize: memory/pinned persistence failed (run already terminal)", {
      runId: run.id,
      err: getErrorMessage(err),
    });
  }

  // Post-CAS best-effort: the run is already terminal in `runs`. A
  // transient log INSERT failure here is logged and swallowed — the UI
  // shows the run as complete from the row-level state regardless.
  try {
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
  } catch (err) {
    logger.error("finalize: appendRunLog terminal row failed", {
      runId: run.id,
      err: getErrorMessage(err),
    });
  }

  // 7. Status-change broadcast with the enriched params (including
  //    validation-failure errors). Fired BEFORE the
  //    notification fan-out so the multi-row INSERT can never sit between the
  //    CAS close and the broadcast — the broadcast is what updates the UI and
  //    fires webhooks, so it must not wait on bell bookkeeping.
  // Merge error + result into ONE `extra` object. Two separate conditional
  // spreads of `extra` would make the second clobber the first (last spread
  // wins), silently dropping the error payload whenever a run carries both an
  // error message and a persisted result (e.g. a runner that reported a
  // deliverable and still stamped a terminal error) — subscribers/webhooks
  // would then never see the failure reason.
  const broadcastExtra: Record<string, unknown> = {};
  if (errorMessage) broadcastExtra.error = errorMessage;
  if (resultToPersist && status === "success") broadcastExtra.result = resultToPersist;
  const broadcastParams: RunStatusChangeParams = {
    ...terminalParams,
    ...(Object.keys(broadcastExtra).length > 0 ? { extra: broadcastExtra } : {}),
  };
  void emitEvent("onRunStatusChange", broadcastParams);

  // Fan out in-app notifications — one row per recipient (issue #667). Only
  // the CAS winner reaches here, so this runs exactly once per run. Awaited
  // (after the broadcast) rather than detached: the run is already terminal
  // and the broadcast has already fired, so the small INSERT adds negligible
  // latency, and awaiting it keeps the write from outliving the request — a
  // detached promise would otherwise race a concurrent run-delete / test
  // teardown. Best-effort by contract: a transient INSERT failure is logged
  // and swallowed, never failing the runner finalize. The `notifications`
  // table is the sole source of notification read-state; a dropped fan-out
  // means a missing bell entry, not a stuck run-list badge (the badge derives
  // from the same table).
  await createRunNotifications(scope, run.id).catch((err) => {
    logger.error("finalize: notification fan-out failed (run already terminal)", {
      runId: run.id,
      err: getErrorMessage(err),
    });
  });
}

/**
 * Re-enter {@link finalizeRun} with a terminal `RunResult` synthesised by
 * the platform — the canonical entry point for any code path that needs to
 * close out a run without going through the runner-posted finalize.
 *
 * Three callers funnel through here today:
 *
 *   - `POST /api/runs/:id/cancel` — user-triggered cancellation. Without
 *     this convergence, the cancel route used to write `status='cancelled'`
 *     directly and the terminal ledger barrier + `onRunStatusChange`
 *     broadcast never ran — metering subscribers observed zero charge for
 *     cancelled runs that had already burned LLM tokens (issue #12 follow-up).
 *   - `listOrphanRunIds` + boot loop — runs that were `running` when the
 *     server crashed are finalised here so billing/observability hooks see
 *     the exact same lifecycle as a clean termination.
 *   - `executeAgentInBackground` synthesised termination — container exit
 *     code, timeout, or orchestrator failure when the runner did not post
 *     its own finalize.
 *
 * Idempotent by design: the CAS on `sink_closed_at IS NULL` inside
 * `finalizeRun` makes this a no-op when the runner has already posted its
 * own terminal — so concurrent synthesis + container-posted finalize ends
 * up applying exactly once.
 */
export async function synthesiseFinalize(
  runId: string,
  terminal: {
    status: "success" | "failed" | "timeout" | "cancelled";
    error?: { message: string; stack?: string };
    durationMs?: number;
  },
): Promise<void> {
  const run = await getRunSinkContext(runId);
  if (!run) {
    logger.error("synthesiseFinalize: run sink context missing", { runId });
    return;
  }

  const result: RunResult = emptyRunResult();
  result.status = terminal.status;
  if (terminal.error) result.error = terminal.error;
  if (terminal.durationMs !== undefined) result.durationMs = terminal.durationMs;

  // The synthesis path carries no runner-posted `result.usage` (the container
  // exited without POSTing its own finalize). Reconstruct the terminal usage
  // from the `runs.tokenUsage` column the `appstrate.metric` side-channel wrote
  // during the run so the zero-token liveness heuristic in `finalizeRun` sees
  // the tokens that were actually consumed — otherwise a synthesised `success`
  // for a run that DID reach the LLM is wrongly flipped to `failed`. (For
  // non-success terminals, `finalizeRun` performs the same reconstruction
  // itself; doing it here too keeps the synthesised RunResult self-consistent.)
  const lastKnownUsage = await readLastKnownUsage(runId);
  if (lastKnownUsage) result.usage = lastKnownUsage;

  await applyRecoveredOutput(run, result);

  await finalizeRun({ run, result });
}

/**
 * Attach the structured deliverable the agent already emitted to a terminal
 * `RunResult` the PLATFORM synthesised — every path where the runner never
 * posted its own finalize ({@link synthesiseFinalize}'s callers, plus the
 * stall watchdog, which builds its own `emptyRunResult()`).
 *
 * WHY: the `output` runtime tool is persisted at emit time as a `run_logs`
 * row, but `runs.result` is written only at finalize, from the RunResult the
 * runner posts. A synthesised terminal carries an `emptyRunResult()`, so a
 * run whose agent had ALREADY delivered its output ended with
 * `runs.result = null` — the payload survived on disk but was invisible to
 * `GET /api/runs/:id`, the dashboard and the CLI's `--output` (issue #1020).
 *
 * RECOVER, NEVER FABRICATE: only a payload that is actually persisted AND a
 * plain record is attached. No row, or a row whose `data` is null, leaves
 * `result.output` exactly as `emptyRunResult()` set it (null) — an agent
 * that never called `output` must keep producing a null result, and the
 * empty `{}` that output-schema validation reports as "never called the
 * tool" must never be manufactured here.
 *
 * FILL IN, NEVER OVERWRITE: a `result` that already carries an `output` is
 * returned untouched (and costs no DB round-trip). A runner-supplied output
 * is the authoritative statement of what the run produced — including a
 * deliberate re-emission ordering this helper's "last row" cannot see — and
 * recovery never second-guesses it. Both call sites pass an
 * `emptyRunResult()` today; the guard is what keeps that from being a
 * precondition a third caller can silently violate.
 *
 * LAST ROW WINS: `output` has replace-on-emit semantics, so the highest
 * `run_logs.id` (append-only) is the payload the agent last meant to
 * deliver — see `readLastEmittedOutput`.
 *
 * PAYLOAD ONLY: the caller's terminal status is untouched. A cancelled run
 * stays `cancelled`, a timeout stays `timeout`; recovering an output never
 * feeds `mapTerminalStatus`. It does legitimately change the outcome of the
 * output-schema validation `finalizeRunImpl` runs on a synthesised
 * `success` — a run that really did emit a valid payload now stays
 * `success` instead of being failed for "finished without calling the
 * required `output` tool".
 */
export async function applyRecoveredOutput(run: RunSinkContext, result: RunResult): Promise<void> {
  if (result.output !== null && result.output !== undefined) return;
  const emitted = await readLastEmittedOutput({ runId: run.id, orgId: run.orgId });
  if (isPlainRecord(emitted)) result.output = emitted;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decide whether the run produced any LLM tokens. Used as a post-run liveness
 * signal — a run that exited "successfully" without consuming tokens never
 * reached an LLM and is treated as a failure. The terminal `result.usage` is
 * the only source of truth; side-channel metric events are for live updates and
 * ledger writes, not for finalize liveness.
 */
function runHadZeroTokens(usage: TokenUsage): boolean {
  return (usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0;
}

/**
 * Did this run consume ANY tokens, in any of the four buckets? Distinct from
 * {@link runHadZeroTokens} (a liveness heuristic on the two roundtrip buckets):
 * this one decides whether there is an accounting fact to pin at the terminal
 * ledger barrier, so a cache-only turn counts too.
 */
function tokenUsageIsNonZero(usage: TokenUsage): boolean {
  return (
    (usage.input_tokens ?? 0) > 0 ||
    (usage.output_tokens ?? 0) > 0 ||
    (usage.cache_read_input_tokens ?? 0) > 0 ||
    (usage.cache_creation_input_tokens ?? 0) > 0
  );
}

/**
 * Tolerant Zod boundary on the runner-supplied finalize `usage`: known numeric
 * fields validated, unknown keys stripped. Absent/invalid shapes return `null`
 * (+ warn log for the malformed case) so the caller decides the fallback —
 * zero usage on a success terminal, last-known snapshot on a non-success one.
 * A malformed billing field can never leave an already-completed run
 * unfinalized.
 */
function validateFinalizeUsage(usage: unknown, runId: string): TokenUsage | null {
  if (usage === null || usage === undefined) return null;
  const parsed = tokenUsageSchema.safeParse(usage);
  if (!parsed.success) {
    logger.warn("finalize: malformed result.usage; ignoring terminal usage field", {
      runId,
      reason: parsed.error.issues[0]?.message ?? "validation failed",
    });
    return null;
  }
  return parsed.data;
}

/**
 * Last-known cumulative usage snapshot for a run — the value the
 * `appstrate.metric` side-channel wrote onto `runs.tokenUsage` during the
 * run. Parsed through the same tolerant Zod boundary as the finalize body so
 * a corrupt JSONB value degrades to `null`, never a throw. Used by finalize
 * to avoid erasing real usage when a run dies without posting a terminal
 * `result.usage`, and by {@link synthesiseFinalize} to reconstruct the
 * terminal usage for platform-synthesised closures.
 */
async function readLastKnownUsage(runId: string): Promise<TokenUsage | null> {
  const [row] = await db
    .select({ tokenUsage: runs.tokenUsage })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!row?.tokenUsage) return null;
  const parsed = tokenUsageSchema.safeParse(row.tokenUsage);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function envelopeToRunEvent(envelope: CloudEventEnvelope, runId: string): RunEvent {
  // The envelope's `data` field carries the event's non-metadata properties
  // (`toolCallId` etc. — copied through untouched). Spread it FIRST so the
  // trusted envelope metadata (`type`, `runId`, `timestamp`) is applied LAST
  // and always wins: `data` is runner-controlled and must never be able to
  // override the authenticated `runId` (server-supplied), the CloudEvent
  // `type` (the dispatch discriminant), or the envelope `time`.
  return {
    ...envelope.data,
    type: envelope.type,
    runId,
    timestamp: Date.parse(envelope.time),
  } as RunEvent;
}

/**
 * Result of a sequence-claim attempt:
 *   - `claimed`     — this caller won the CAS and dispatched the event.
 *   - `lost_race`   — another concurrent ingestion path claimed the
 *                     sequence; the in-memory snapshot was refreshed.
 *   - `sink_closed` — the run's sink closed (finalize won) between the
 *                     middleware's snapshot read and this CAS; nothing was
 *                     written. Callers must not treat this as retryable
 *                     ordering noise — the run is terminal.
 */
type AdvanceOutcome = "claimed" | "lost_race" | "sink_closed";

async function persistEventAndAdvance(
  run: RunSinkContext,
  event: RunEvent,
  sequence: number,
  opts: { allowGap?: boolean } = {},
): Promise<AdvanceOutcome> {
  // Claim the sequence atomically BEFORE dispatching. The CAS is the
  // single point of serialisation across concurrent ingestion paths
  // (fast-path POST + drain racing against a second POST whose drain
  // peeks the same buffered sequence). Dispatch-first would let both
  // racers INSERT identical run_logs rows for the same sequence —
  // `appendRunLog` has no idempotency key, and the platform-wide replay
  // cache only dedupes on `(runId, webhookId)`. Reversing the order
  // means whoever loses the CAS observes zero affected rows and skips
  // dispatch entirely.
  //
  // `allowGap`: relax the predecessor check to `lastEventSequence <
  // sequence`. Used by the terminal drain in finalize when a fast-path
  // POST never arrived for some intermediate sequence — the strict
  // `= sequence - 1` CAS would otherwise reject every buffered event
  // past the missing one and they would be silently lost.
  const predicate = opts.allowGap
    ? sql`${runs.lastEventSequence} < ${sequence}`
    : eq(runs.lastEventSequence, sequence - 1);

  // Wrap the CAS + dispatch in a single transaction so a transient
  // INSERT failure inside `persistRunEvent` rolls the sequence advance
  // back. Otherwise we could leave `runs.last_event_sequence` advanced
  // with no `run_logs` row to back it — a silent loss that the next
  // event's CAS would tolerate without retrying the dropped one.
  const scope = { orgId: run.orgId, spaceId: run.spaceId };
  const firstEvent = run.lastEventSequence === 0;
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(runs)
      // `isNull(sinkClosedAt)` is load-bearing (CRIT-12): the middleware's
      // `assertSinkOpen` runs on a SNAPSHOT, so a concurrent finalize can
      // close the sink between that read and this commit. Putting the
      // closure check inside the CAS WHERE makes a lost race a no-op —
      // a closed run can never gain new events or be flipped back to
      // `running` by the firstEvent branch below.
      .set({ lastEventSequence: sequence, lastHeartbeatAt: new Date() })
      .where(and(eq(runs.id, run.id), isNull(runs.sinkClosedAt), predicate))
      .returning({ id: runs.id });
    if (rows.length === 0) return false;

    await persistRunEvent(tx, scope, run.id, event, {
      writeLedger: true,
      modelSource: run.modelSource,
      modelCost: run.modelCost,
    });

    // No runner emits `run.started`, so flip status → running on the
    // first ingested sequence regardless of type. Terminal status is
    // owned by finalizeRun. (`updateRun` additionally enforces the
    // monotone status invariant — a terminal run can never re-enter
    // `running` even from paths that bypass this CAS.)
    if (firstEvent) {
      await updateRun(scope, run.id, { status: "running" }, tx);
    }
    return true;
  });

  if (!claimed) {
    // Zero rows matched — distinguish WHY in one re-read: the sink closed
    // (finalize won the race → surface a 410 upstream, not a silent write)
    // vs another concurrent path claimed this sequence (refresh the
    // in-memory snapshot so the caller's drain loop recomputes `next`
    // against actual DB state — otherwise it bails out on a false
    // gap-at-head and strands every subsequent buffered event until
    // finalize's gap_fill). A vanished row (deleted mid-flight) is
    // reported as closed — the run can't accept events either way.
    const [fresh] = await db
      .select({ closed: runs.sinkClosedAt, seq: runs.lastEventSequence })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    if (!fresh || fresh.closed !== null) return "sink_closed";
    if (fresh.seq > run.lastEventSequence) run.lastEventSequence = fresh.seq;
    return "lost_race";
  }

  run.lastEventSequence = sequence;

  // Emit `run.started` for remote-origin runs at the moment the DB
  // actually transitions pending → running (the first ingested event).
  // Platform-origin runs already emit `started` from
  // `executeAgentInBackground` when they flip the row, so they are
  // excluded here to avoid a duplicate. Remote runs no longer emit at
  // row-insert time (run-creation.ts) — that fired before the DB
  // transition and never again when it actually happened.
  if (firstEvent && run.runOrigin === "remote") {
    void emitEvent("onRunStatusChange", {
      orgId: run.orgId,
      runId: run.id,
      packageId: run.packageId,
      spaceId: run.spaceId,
      status: "started",
      packageEphemeral: isInlineShadowPackageId(run.packageId),
      ...(run.modelSource !== null ? { modelSource: run.modelSource } : {}),
    });
  }

  return "claimed";
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
      const outcome = await persistEventAndAdvance(run, head.event, head.sequence);
      if (outcome === "sink_closed") {
        // Finalize won mid-drain: the run is terminal, nothing more can be
        // persisted. Stop without removing — the buffered rows expire via
        // TTL and must never land as writes on a closed sink.
        logger.debug("drain stopped — sink closed mid-drain", { runId: run.id });
        return;
      }
      // `claimed` persisted the event; `lost_race` means another drainer
      // claimed this exact sequence (its event is persisted) — in both
      // cases the buffered copy is spent.
      await buffer.remove(run.id, head.sequence);
      continue;
    }

    if (opts.allowGaps && head.sequence > next) {
      logger.warn("remote run flushed with sequence gap", {
        runId: run.id,
        expectedSequence: next,
        actualSequence: head.sequence,
      });
      const outcome = await persistEventAndAdvance(run, head.event, head.sequence, {
        allowGap: true,
      });
      if (outcome === "sink_closed") {
        logger.debug("gap drain stopped — sink closed mid-drain", { runId: run.id });
        return;
      }
      await buffer.remove(run.id, head.sequence);
      continue;
    }

    // Gap at the head and gaps not allowed — could be a real gap, or a
    // stale view where a concurrent drainer advanced `lastEventSequence`
    // and removed the buffer's old lowest. Refresh from DB and retry
    // before giving up; otherwise concurrent buffer-path drainers (one
    // per bursty parallel-call event) all observe a false gap, exit
    // early, and the buffer sits until finalize.
    if (await refreshSequence(run)) continue;
    return;
  }
}

function mapTerminalStatus(result: RunResult): "success" | "failed" | "timeout" | "cancelled" {
  // Explicit status wins — runner-provided terminal cause (timeout,
  // cancellation) is authoritative over inference from `error`.
  if (result.status) return result.status;
  return result.error ? "failed" : "success";
}
