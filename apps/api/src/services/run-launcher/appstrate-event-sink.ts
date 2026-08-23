// SPDX-License-Identifier: Apache-2.0

/**
 * Run-event write-through — persists `run_logs`, snapshots token usage onto the
 * run row, and upserts the run's `llm_usage` runner row.
 *
 * A runner row's `cost_usd` is computed HERE, server-side, from the run's
 * kickoff rate snapshot (`runs.model_cost`) and the token counts the runner
 * reports — never from the `cost` the container reports; see
 * {@link resolveRunnerCost}.
 *
 * This module is the single writer of the `llm_usage` runner rows and the
 * single reader/writer of `runs.tokenUsage`.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { isPlainObject } from "@appstrate/core/safe-json";
import { fileUri } from "@appstrate/core/file-uri";
import { LEGACY_RUNTIME_TOOL_EVENT_TYPES } from "@appstrate/core/runtime-tool-defs";
import type { Db } from "@appstrate/db/client";
import { modelCostSchema, type ModelCost } from "@appstrate/core/module";
import { computeTokenCost, type TokenPricingStatus } from "@appstrate/afps-runtime/runner";
import { type CredentialSource } from "../llm-usage-ledger.ts";
import { recordLlmUsageReliably } from "../llm-usage-retry.ts";
import { resolvePricingStatus } from "../pricing-provenance.ts";
import type { AppScope } from "../../lib/scope.ts";
import { appendRunLog, updateRun } from "../state/runs.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import type { TokenUsage } from "./types.ts";
import { scheduleRunMetricBroadcast } from "../run-metric-broadcaster.ts";

const FILE_PUBLISHED_EVENT_TYPE = "file.published";

/** Forward-map a retired event type: the `document.` subject became `file.`. */
function canonicalRuntimeToolEventType(type: string): string {
  return type.startsWith("document.") ? `file.${type.slice("document.".length)}` : type;
}

/**
 * Every spelling this sink ingests as a published run file. Derived from
 * `LEGACY_RUNTIME_TOOL_EVENT_TYPES` rather than hand-listed, so an alias added
 * there cannot fall through to `default` here.
 */
const FILE_PUBLISHED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  FILE_PUBLISHED_EVENT_TYPE,
  ...LEGACY_RUNTIME_TOOL_EVENT_TYPES.filter(
    (type) => canonicalRuntimeToolEventType(type) === FILE_PUBLISHED_EVENT_TYPE,
  ),
]);

/**
 * Dispatch one {@link RunEvent} through the platform write-through table.
 * Returns the `appstrate.error.message` when this event was one, else null.
 * `executor` is a parameter so the ingestion path can pass its transaction: the
 * `runs.last_event_sequence` CAS and the `run_logs` INSERT must commit together.
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
  // Normalise every accepted alias onto its canonical type before dispatch, so
  // the switch below carries one `case` per event.
  const eventType = FILE_PUBLISHED_EVENT_TYPES.has(event.type)
    ? FILE_PUBLISHED_EVENT_TYPE
    : event.type;

  switch (eventType) {
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
        // `event='log'` marks rows from the agent's explicit `log` tool, not
        // auto-emitted breadcrumbs. The chat run card shows ONLY these.
        await appendRunLog(scope, runId, "progress", "log", message, null, level, executor);
      }
      return null;
    }

    case FILE_PUBLISHED_EVENT_TYPE: {
      // The `files` row already exists (POST /api/runs/:id/files); this event
      // only persists a run_log so the file streams over the run_log SSE. The
      // `"file"` tag written below must stay the first member of
      // `PUBLISHED_FILE_LOG_EVENTS` (`@appstrate/core/file-uri`) — every reader
      // filters run_log lines on that list, and retired values must stay in it
      // for historical rows. `document_id` is the pre-rename payload key.
      const rawFileId = event.file_id ?? event.document_id;
      const fileId = typeof rawFileId === "string" ? rawFileId : null;
      if (fileId) {
        await appendRunLog(
          scope,
          runId,
          "result",
          "file",
          null,
          {
            file_id: fileId,
            uri: typeof event.uri === "string" ? event.uri : fileUri(fileId),
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
      // Advisory on a platform run (see {@link resolveRunnerCost}); the
      // recorded cost only for a remote-origin run.
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
      // Ledger row — only the ingestion path opts in. A runner write is never
      // retried asynchronously (a replay past settlement is refused): it throws
      // and aborts the ingestion transaction, so the sequence never advances
      // and the runner's next cumulative snapshot replaces this one.
      if (opts.writeLedger) {
        await writeRunnerLedgerRow(
          scope,
          runId,
          { cost, usage, modelSource: opts.modelSource, modelCost: opts.modelCost },
          { executor },
        );
        // Best-effort live broadcast, throttled per run — never blocks the
        // ingestion hot path nor fails it.
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
 * Upsert the run's `source="runner"` row in the `llm_usage` ledger. `cost_usd`
 * is NOT `row.cost` — see {@link resolveRunnerCost}.
 *
 * The runner reports CUMULATIVE totals, so this is one row per run (partial
 * unique index `uq_llm_usage_runner_run_id`) upserted with the latest total,
 * never an append of a delta. It advances on a strictly larger `cost_usd`, or
 * an equal cost with a strictly larger token total (which keeps a zero-cost
 * model advancing) — so reorder and replay are safe.
 */
export async function writeRunnerLedgerRow(
  scope: AppScope,
  runId: string,
  row: {
    /** Cost as the CONTAINER computed it — see {@link resolveRunnerCost}. */
    cost: number | null;
    usage: TokenUsage | null;
    /** Run's model source — stamped as `credential_source`. */
    modelSource?: string | null;
    /** Run's kickoff rate snapshot — prices the row and classifies it. */
    modelCost?: ModelCost | null;
  },
  opts: {
    /** Executor — the ingestion transaction on the metric hot path. */
    executor?: Db;
    /**
     * Require the write to be durable before the run settles: a settled runner
     * row is claimed by a billing cursor once, by its existing serial id, so a
     * later update strands the delta.
     */
    required?: boolean;
  } = {},
): Promise<void> {
  // Degenerate-event skip — nothing to bill or audit. Keyed on whichever input
  // this row's cost is DERIVED from: the usage snapshot on a platform run, the
  // reported `cost` on a remote-origin run. A platform run with tokens but no
  // rates is NOT skipped — it lands as a `costUsd: 0` row carrying a pricing
  // status, and that zero must not read as "free".
  const serverPriced = costIsServerComputed(row.modelSource);
  if (!row.usage && (serverPriced || row.cost === null)) return;

  const { costUsd, pricingStatus } = resolveRunnerCost(scope.orgId, runId, row);
  warnOnReportedCostDivergence(scope.orgId, runId, row.cost, costUsd, {
    serverPriced,
    // `required` is set only by finalize's terminal ledger barrier, which makes
    // it this producer's once-per-run hook.
    terminal: opts.required === true,
  });

  try {
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
        costUsd,
        pricingStatus,
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
 * True when the platform resolved a model for this run and therefore holds its
 * rates (`runs.model_cost`). A NULL `model_source` is the remote-origin
 * signature (the same fact `notRunnerMirrorSql` keys on): no server-side rates,
 * so the runner's own figure is all there is.
 */
function costIsServerComputed(modelSource: string | null | undefined): boolean {
  return coerceCredentialSource(modelSource) !== null;
}

interface RunnerCostVerdict {
  costUsd: number;
  pricingStatus: TokenPricingStatus | null;
}

/**
 * Price a runner row SERVER-SIDE, and classify what that price is worth.
 *
 * The `cost` on an `appstrate.metric` event is produced inside the agent
 * container and is advisory: the platform holds both factors itself — the
 * kickoff snapshot `runs.model_cost` and the reported counts — and multiplies
 * them with `computeTokenCost`, the same formula the LLM-proxy meter uses. That
 * also lets `MODEL_COST` be withheld from a container running an aliased model
 * without changing what the run is billed.
 *
 * BILLING: a run that dies without terminal usage (watchdog kill, crash,
 * timeout, cancel) is priced from the cumulative snapshot finalize preserved,
 * so it bills its real consumption rather than settling at $0
 * (`test/integration/services/llm-usage-settlement.test.ts`).
 *
 * Never recompute from a per-event DELTA: the upsert discards a snapshot whose
 * cost went down, and only cumulative counters × constant rates is monotone.
 *
 * Cost and status come from ONE set of inputs. A NULL `model_source`
 * short-circuits both: `null` status (the platform makes no claim — that run's
 * inference is accounted elsewhere) and the pass-through cost. `model_cost` is
 * JSONB, so both halves read it narrowed: an unvalidated `{}` would classify as
 * fully priced and make `computeTokenCost` write `NaN`.
 */
function resolveRunnerCost(
  orgId: string,
  runId: string,
  row: {
    cost: number | null;
    usage: TokenUsage | null;
    modelSource?: string | null;
    modelCost?: ModelCost | null;
  },
): RunnerCostVerdict {
  if (!costIsServerComputed(row.modelSource)) {
    return { costUsd: row.cost ?? 0, pricingStatus: null };
  }
  const parsedCost = modelCostSchema.safeParse(row.modelCost);
  const rates = parsedCost.success ? parsedCost.data : null;
  const usage = row.usage ?? {};
  return {
    costUsd: computeTokenCost(usage, rates),
    pricingStatus: resolvePricingStatus({
      orgId,
      // The run's model label is not in the sink context, so the warn line is
      // keyed on the org alone and names the run instead.
      model: null,
      usage,
      cost: rates,
      context: { source: "runner", runId },
    }),
  };
}

/**
 * Tolerance below which the container's figure and the server's are the same
 * number: far above float noise, far below any real formula disagreement.
 */
const REPORTED_COST_DIVERGENCE_USD = 1e-6;

/**
 * CUTOVER INSTRUMENT — delete once the recompute has been observed clean in
 * production, together with the container's `cost` on the event envelope. The
 * server number stays authoritative regardless; parity is pinned by
 * `apps/api/test/unit/runner-cost-parity.test.ts`.
 *
 * Fires at most once per run, on the terminal write: the counters are
 * cumulative, so that snapshot carries the run's full gap.
 */
function warnOnReportedCostDivergence(
  orgId: string,
  runId: string,
  reportedCostUsd: number | null,
  costUsd: number,
  at: { serverPriced: boolean; terminal: boolean },
): void {
  if (!at.terminal) return;
  // The pass-through branch writes the reported number verbatim; there are no
  // two numbers to compare.
  if (!at.serverPriced || reportedCostUsd === null) return;
  const deltaUsd = reportedCostUsd - costUsd;
  if (Math.abs(deltaUsd) <= REPORTED_COST_DIVERGENCE_USD) return;
  logger.warn("llm_usage: runner-reported cost diverges from the server-computed cost", {
    runId,
    orgId,
    reportedCostUsd,
    costUsd,
    deltaUsd,
  });
}
