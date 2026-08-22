// SPDX-License-Identifier: Apache-2.0

/**
 * Appstrate-backed run-event write-through — persists `run_logs`, snapshots
 * token usage onto the run row, and appends cost to the unified `llm_usage`
 * ledger.
 *
 * The single entry point is the free function {@link persistRunEvent}. It is a
 * function rather than a sink object because the ingestion path must run the
 * dispatch INSIDE its Drizzle transaction (the `runs.last_event_sequence` CAS
 * and the `run_logs` INSERT have to commit together) — an object holding its
 * own `db` handle structurally cannot do that.
 *
 * Canonical AFPS aggregation (`snapshot()` / `RunResult`) is NOT this module's
 * job. A caller that needs to read an aggregate back composes a runtime reducer
 * (`createReducerSink()` from `@appstrate/afps-runtime/sinks`); no platform
 * code path does.
 *
 * Event routing:
 *
 *   Platform write-through:
 *     output.emitted  → run_logs (result/output)
 *     log.written     → run_logs (progress/log) with level
 *
 *   Platform-specific (`appstrate.*` namespace):
 *     appstrate.progress → run_logs (progress/progress) with message/data/level
 *     appstrate.error    → run_logs (system/adapter_error); the message is
 *                          RETURNED so the caller can cache it
 *     appstrate.metric   → runs.tokenUsage snapshot (running total)
 *                         + llm_usage ledger row (source="runner")
 *                         + schedules a throttled `run_metric` broadcast
 *                           which also persists `cost_so_far` onto the
 *                           run row (monotonic-max guarded)
 *
 * This module is the single writer of the `llm_usage` runner rows and the
 * single reader/writer of `runs.tokenUsage`. `runs.cost` is a cached aggregate
 * of `llm_usage` and is refreshed on two paths: the throttled broadcaster
 * (during streaming, via {@link scheduleRunMetricBroadcast}) and `finalizeRun`
 * (terminal write). Both writers use a monotonic guard so the recorded value
 * never regresses.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { isPlainObject } from "@appstrate/core/safe-json";
import { documentUri } from "@appstrate/core/document-uri";
import type { Db } from "@appstrate/db/client";
import { modelCostSchema, type ModelCost } from "@appstrate/core/module";
import type { TokenPricingStatus } from "@appstrate/afps-runtime/runner";
import { type CredentialSource } from "../llm-usage-ledger.ts";
import { recordLlmUsageReliably } from "../llm-usage-retry.ts";
import { resolvePricingStatus } from "../pricing-provenance.ts";
import type { AppScope } from "../../lib/scope.ts";
import { appendRunLog, updateRun } from "../state/runs.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { TokenUsage } from "./types.ts";
import { scheduleRunMetricBroadcast } from "../run-metric-broadcaster.ts";

/**
 * Dispatch one {@link RunEvent} through the platform write-through table.
 * Extracted so the ingestion hot path can run the dispatch inside a
 * Drizzle transaction (passing `tx` as the executor) — that way the CAS
 * advance of `runs.last_event_sequence` and the `run_logs` INSERT
 * commit-or-roll-back atomically. A transient INSERT failure no longer
 * leaves a sequence advanced with no log row to back it.
 *
 * Returns the `appstrate.error.message` if this event was one, so the
 * caller can update its own `lastAdapterError` cache.
 */
export async function persistRunEvent(
  executor: Db,
  scope: AppScope,
  runId: string,
  event: RunEvent,
  opts: {
    writeLedger?: boolean;
    modelSource?: string | null;
    modelCost?: ModelCost | null;
  } = {},
): Promise<string | null> {
  switch (event.type) {
    case "output.emitted": {
      await appendRunLog(
        scope,
        runId,
        "result",
        "output",
        null,
        (event.data as Record<string, unknown> | null | undefined) ?? null,
        "info",
        executor,
      );
      return null;
    }

    case "log.written": {
      const level = event.level;
      const message = event.message;
      if (
        (level === "info" || level === "warn" || level === "error") &&
        typeof message === "string"
      ) {
        // `event='log'` (not the generic `'progress'`) tags rows that came from
        // the agent's explicit `log` runtime tool, so consumers can isolate the
        // agent's own narration from auto-emitted lifecycle/tool-call
        // breadcrumbs (which share `type='progress'`). The chat run card shows
        // ONLY these `log` rows. The dashboard log viewer treats unknown events
        // generically, so it renders them unchanged.
        await appendRunLog(scope, runId, "progress", "log", message, null, level, executor);
      }
      return null;
    }

    case "document.published": {
      // A run document was stored on the platform (via the `publish_document`
      // tool or the entrypoint outputs sweep). The `documents` row already
      // exists (created by the POST /api/runs/:id/documents route) — this
      // event carries no new DB state, it only persists a run_log so the
      // published document streams over the existing run_log SSE and replays.
      // Stored as `type='result' event='document'`, mirroring output.
      const documentId = typeof event.document_id === "string" ? event.document_id : null;
      if (documentId) {
        await appendRunLog(
          scope,
          runId,
          "result",
          "document",
          null,
          {
            document_id: documentId,
            uri: typeof event.uri === "string" ? event.uri : documentUri(documentId),
            name: typeof event.name === "string" ? event.name : null,
            mime: typeof event.mime === "string" ? event.mime : null,
            size: typeof event.size === "number" ? event.size : null,
            sha256: typeof event.sha256 === "string" ? event.sha256 : null,
          },
          "info",
          executor,
        );
      }
      return null;
    }

    case "appstrate.progress": {
      const message = typeof event.message === "string" ? event.message : null;
      const data = isPlainObject(event.data) ? event.data : null;
      const level = resolveLogLevel(event.level) ?? "debug";
      await appendRunLog(scope, runId, "progress", "progress", message, data, level, executor);
      return null;
    }

    case "appstrate.error": {
      const message = typeof event.message === "string" ? event.message : null;
      const data = isPlainObject(event.data) ? event.data : null;
      await appendRunLog(scope, runId, "system", "adapter_error", message, data, "error", executor);
      return message;
    }

    case "appstrate.metric": {
      const usage = isPlainObject(event.usage) ? (event.usage as TokenUsage) : null;
      const cost = typeof event.cost === "number" ? event.cost : null;

      // Token usage is a running-total snapshot on the run row.
      if (usage) {
        await updateRun(
          scope,
          runId,
          { tokenUsage: usage as unknown as Record<string, unknown> },
          executor,
        );
      }
      // Ledger row — only the ingestion path opts in. The runner emits
      // cumulative running totals on each metric event, so concurrent
      // writers (a later metric event, the finalize-time fallback)
      // UPSERT the row with monotonic-max semantics.
      //
      // A runner write is NEVER deferred to the durable retry queue: a replay
      // could only land after the run settled, and a cumulative snapshot
      // replayed past settlement is REFUSED (see `runNotTerminalSql`). A
      // failure therefore throws, aborting the surrounding ingestion
      // transaction — the sequence never advances, so the runner re-POSTs and
      // its NEXT cumulative snapshot supersedes the lost one. Cumulativity is
      // what makes discarding a failed write safe here.
      if (opts.writeLedger) {
        await writeRunnerLedgerRow(
          scope,
          runId,
          { cost, usage, modelSource: opts.modelSource, modelCost: opts.modelCost },
          { executor },
        );
        // Best-effort live broadcast — never blocks the ingestion hot
        // path nor fails it. The broadcaster throttles per-run to
        // avoid flooding SSE subscribers under bursty metric emission
        // (e.g. tool-heavy turns).
        scheduleRunMetricBroadcast(runId);
      }
      return null;
    }

    default:
      // memory.added / pinned.set / third-party — no run_logs row.
      return null;
  }
}

function resolveLogLevel(value: unknown): "debug" | "info" | "warn" | "error" | null {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

/**
 * Write (upsert) the runner-source row for a run in the `llm_usage` ledger.
 *
 * The runner emits cumulative running totals on every `appstrate.metric`
 * event, so the row tracks the latest total seen — concurrent writers
 * (a later metric event, the finalize-time fallback) UPSERT into the
 * partial unique index `uq_llm_usage_runner_run_id`. The conflict clause
 * is two-level monotonic: an UPDATE takes effect when the incoming
 * `cost_usd` is strictly larger than the stored value, OR the cost is
 * equal and the incoming total token count is strictly larger. The token
 * tiebreak keeps a zero-cost model's snapshot advancing (cost stays 0
 * while tokens climb), so:
 *
 *   - rapid-fire metric events keep the row in sync with the latest total
 *   - a finalize-fallback emit with a smaller `result.cost` (e.g. when
 *     a fresh metric already landed) cannot regress the bill
 *   - reorder is safe — the highest-seen total wins regardless of arrival
 *     order
 *
 * `opts.executor` writes inside the ingestion transaction; the finalize-fallback
 * caller omits it and runs outside any transaction.
 */
export async function writeRunnerLedgerRow(
  scope: AppScope,
  runId: string,
  row: {
    cost: number | null;
    usage: TokenUsage | null;
    /** Run's model source — stamped as `credential_source` (see below). */
    modelSource?: string | null;
    /** Run's kickoff rate snapshot — classifies `pricing_status` (see below). */
    modelCost?: ModelCost | null;
  },
  opts: {
    /** Executor — pass the ingestion transaction on the metric hot path. */
    executor?: Db;
    /**
     * Finalization barrier: require the terminal cumulative snapshot to be in
     * Postgres before the run becomes settled. Cloud claims a runner row by its
     * existing serial id, so asynchronously updating it after settlement could
     * otherwise strand the final delta.
     */
    required?: boolean;
  } = {},
): Promise<void> {
  // Skip degenerate events with neither usage nor cost — nothing to bill
  // or audit. NOTE the asymmetry the pricing status exists for: a run with
  // tokens but a NULL cost is NOT skipped — it lands as a `costUsd: 0` row
  // below, and that zero is precisely the one that must not read as "free".
  if (row.cost === null && !row.usage) return;

  try {
    // The single ledger writer performs the monotonic upsert against the
    // partial unique index (highest cumulative total wins).
    await recordLlmUsageReliably(
      {
        source: "runner",
        orgId: scope.orgId,
        runId,
        credentialSource: coerceCredentialSource(row.modelSource),
        inputTokens: row.usage?.input_tokens ?? 0,
        outputTokens: row.usage?.output_tokens ?? 0,
        cacheReadTokens: row.usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: row.usage?.cache_creation_input_tokens ?? null,
        costUsd: row.cost ?? 0,
        pricingStatus: resolveRunnerPricingStatus(scope.orgId, runId, row),
      },
      {
        executor: opts.executor,
        onConflict: "runner-monotonic",
        required: opts.required,
      },
    );
  } catch (err) {
    logger.error("Failed to write runner ledger row", {
      runId,
      error: getErrorMessage(err),
    });
    throw err;
  }
}

/** Narrow a run's free-form `model_source` to the `credential_source` enum. */
function coerceCredentialSource(modelSource: string | null | undefined): CredentialSource | null {
  return modelSource === "system" || modelSource === "org" ? modelSource : null;
}

/**
 * Pricing provenance of a runner row, derived SERVER-SIDE.
 *
 * The container computed the `cost` this row carries, so the platform cannot
 * ask it whether that number was backed by real rates — it answers from the
 * snapshot it took at kickoff (`runs.model_cost`).
 *
 * `runs.model_source IS NULL` short-circuits to `null`, and that branch is not a
 * defensive default: a NULL model source is precisely how a REMOTE-origin run is
 * identified (it resolves no platform model — the same fact `notRunnerMirrorSql`
 * keys on). Its inference was accounted elsewhere, typically as per-call proxy
 * rows that carry their own status. Stamping `unpriced` there would mislabel
 * every remote run as a platform pricing gap.
 *
 * The snapshot is a JSONB column, so it is NARROWED rather than trusted: a row
 * whose `model_cost` is malformed (hand-edited, or written by an older shape)
 * must classify as `unpriced`, not as `priced`. `classifyTokenPricing` only
 * probes `cost == null` and `cost.cacheRead`, so an unvalidated `{}` would
 * otherwise sail through as fully priced — the exact false confidence this
 * column exists to remove.
 */
function resolveRunnerPricingStatus(
  orgId: string,
  runId: string,
  row: { usage: TokenUsage | null; modelSource?: string | null; modelCost?: ModelCost | null },
): TokenPricingStatus | null {
  if (coerceCredentialSource(row.modelSource) === null) return null;
  const parsedCost = modelCostSchema.safeParse(row.modelCost);
  return resolvePricingStatus({
    orgId,
    // The run's model label is not part of the sink context, so the warn line
    // is keyed on the org alone (one line per org+status per process) and names
    // the run instead — `runs.model_label` is one lookup away, and the ledger
    // column is the complete, queryable record either way.
    model: null,
    usage: row.usage ?? {},
    cost: parsedCost.success ? parsedCost.data : null,
    context: { source: "runner", runId },
  });
}
