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
 * The ledger row's `cost_usd` is computed HERE, server-side, from the run's
 * kickoff rate snapshot (`runs.model_cost`) and the token counts the runner
 * reports — never from the `cost` the container reports alongside them. See
 * {@link resolveRunnerCost}.
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

/** The canonical event type this sink ingests as "a run file was published". */
const FILE_PUBLISHED_EVENT_TYPE = "file.published";

/**
 * #1177's rename applied to an event type's SUBJECT segment
 * (`document.published` → `file.published`). The rename was total — the
 * `document` subject became `file` across the whole run-event vocabulary — so
 * the forward mapping of a retired spelling IS this substitution.
 */
function canonicalRuntimeToolEventType(type: string): string {
  return type.startsWith("document.") ? `file.${type.slice("document.".length)}` : type;
}

/**
 * Every spelling this sink must ingest as a published run file: the canonical
 * type plus each retired one `@appstrate/core` still ACCEPTS.
 *
 * READ from `LEGACY_RUNTIME_TOOL_EVENT_TYPES` rather than restated. That table
 * calls itself "the one place a retired spelling is mapped forward", and
 * `reEmitRuntimeToolEvents` forwards everything in it — so an alias added there
 * but missing from a hand-written `case` here would fall straight through to
 * `default`: the file stored, and nothing anywhere in the run log saying why.
 * Reading the table makes that drift impossible for the published-file event.
 *
 * A future alias whose forward mapping is NOT the `document.` → `file.`
 * substitution belongs to some other canonical event and is deliberately left
 * out of this set — it would need its own `case`, exactly as `memory.added` and
 * `pinned.set` (accepted by core, intentionally no-ops here) already do.
 */
const FILE_PUBLISHED_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  FILE_PUBLISHED_EVENT_TYPE,
  ...LEGACY_RUNTIME_TOOL_EVENT_TYPES.filter(
    (type) => canonicalRuntimeToolEventType(type) === FILE_PUBLISHED_EVENT_TYPE,
  ),
]);

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
  // Route every accepted spelling of the published-file event onto its
  // canonical type BEFORE dispatch, so the switch below carries one `case` and
  // the alias list stays where core owns it. `RunEvent.type` is an open
  // `string` (AFPS wire envelope), so switching on a derived value costs no
  // narrowing.
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

    // Reached by `file.published` AND by every retired spelling in
    // `FILE_PUBLISHED_EVENT_TYPES` above (today: `document.published`). Both
    // are accepted forever: the runtime-pi image and the platform deploy
    // independently, so a container built before the rename still emits the old
    // shape. Only `file.published` / `file_id` are ever EMITTED (see
    // `filePublishedEvent()` in @appstrate/core).
    case FILE_PUBLISHED_EVENT_TYPE: {
      // A run file was stored on the platform (via the `publish_file`
      // tool or the entrypoint outputs sweep). The `files` row already
      // exists (created by the POST /api/runs/:id/files route) — this
      // event carries no new DB state, it only persists a run_log so the
      // published file streams over the existing run_log SSE and replays.
      // Stored as `type='result' event='file'`, mirroring output.
      //
      // COUPLING — the literal `"file"` tag written below is the CANONICAL
      // member of `PUBLISHED_FILE_LOG_EVENTS` (`@appstrate/core/file-uri`,
      // `["file", "document"]`), the list every reader filters run_log lines
      // with (`apps/web/src/lib/files.ts`, `module-chat`'s run-events
      // projection). It is not derived from that list on purpose: the list is a
      // READER's alias set — it exists to accept the rows this writer used to
      // write — so deriving the write from it would invert the direction. If
      // this tag ever changes, `PUBLISHED_FILE_LOG_EVENTS[0]` must change with
      // it and the old value must stay in the list for historical rows.
      //
      // The PAYLOAD-key half of the same rename. It cannot be derived the way
      // the type is: core catalogues retired event TYPES
      // (`LEGACY_RUNTIME_TOOL_EVENT_TYPES`) and nothing catalogues retired
      // payload keys, so there is no table to consult — only `@appstrate/core`
      // could own one, and it does not. Kept literal, and read only as a
      // fallback: a pre-rename image emits `document.published` with
      // `document_id`, everything since emits `file.published` with `file_id`.
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
      // The container's own cost figure. Advisory on a platform run — the ledger
      // price is recomputed from `runs.model_cost` × `usage` (see
      // {@link resolveRunnerCost}) and this value only feeds the cutover
      // divergence check. It is still the recorded cost of a remote-origin run,
      // for which the platform holds no rates.
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
 * The row's `cost_usd` is NOT `row.cost`: it is recomputed here from the run's
 * kickoff rate snapshot and the reported token counts ({@link resolveRunnerCost}),
 * so the number billing debits from is never one the sandbox produced.
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
 *   - a finalize-fallback emit carrying a smaller cumulative snapshot (e.g.
 *     when a fresher metric already landed) cannot regress the bill
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
    /**
     * Cost as the CONTAINER computed it (Pi SDK × the `MODEL_COST` rates the
     * platform handed it). NOT what lands in the ledger — see
     * {@link resolveRunnerCost}. Retained only so the cutover can detect a
     * formula divergence, and because a remote-origin run has no server-side
     * rates to recompute from.
     */
    cost: number | null;
    usage: TokenUsage | null;
    /** Run's model source — stamped as `credential_source` (see below). */
    modelSource?: string | null;
    /** Run's kickoff rate snapshot — prices the row + classifies it (see below). */
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
  // Degenerate-event skip — nothing to bill or audit. The predicate keys on
  // whichever input this row's cost is DERIVED from, which is no longer the
  // same thing on both branches:
  //
  //   - platform run  → the usage snapshot. The container's `cost` stopped
  //     being an input, so a cost-only event now recomputes to exactly 0 and
  //     would mint an all-zero row pinning no accounting fact.
  //   - remote-origin run (NULL `model_source`) → the reported `cost`. The
  //     platform resolved no model for it and therefore holds no rates to
  //     recompute with; it passes the number through, so a cost-only event
  //     still carries a fact and must NOT be skipped.
  //
  // The asymmetry the pricing status exists for survives untouched: a platform
  // run with tokens but no rates is NOT skipped — it lands as a `costUsd: 0`
  // row below, and that zero is precisely the one that must not read as "free".
  //
  // Can the new platform-run branch drop real spend — a non-null `cost` with a
  // null `usage`, which the old predicate would have written at the container's
  // number? No, and not by luck; neither producer can build that pair:
  //
  //   - Finalize's terminal barrier CANNOT pass a null usage. Its chain in
  //     `run-event-ingestion.ts` is `validateFinalizeUsage(result.usage)` →
  //     `readLastKnownUsage(run)` → an UNCONDITIONAL
  //     `{ input_tokens: 0, output_tokens: 0 }` fallback, so the value handed
  //     here is always an object. That middle step is also where a run that died
  //     without terminal usage keeps its spend: the preserved `runs.tokenUsage`
  //     cumulative snapshot IS what the recompute prices, so a watchdog kill or
  //     container crash is billed off its last known counters, not zeroed.
  //   - The metric path's canonical producer is
  //     `buildMetric(base, usage, cost?)` (`@appstrate/afps-runtime/runner`),
  //     where `usage` is a REQUIRED positional and `cost` the optional one — the
  //     pair is structurally incapable of arriving cost-only. The null check
  //     survives only because `RunEvent` is an open wire envelope (an old or
  //     third-party runner POSTs whatever it likes).
  //
  // And in that last, non-canonical case nothing server-knowable is lost either:
  // a platform run whose event carries no counters recomputes to 0 by
  // definition, so the row the old predicate wrote would now be all-zero anyway,
  // and the terminal barrier still writes the run's row from its own usage.
  const serverPriced = costIsServerComputed(row.modelSource);
  if (!row.usage && (serverPriced || row.cost === null)) return;

  const { costUsd, pricingStatus } = resolveRunnerCost(scope.orgId, runId, row);
  warnOnReportedCostDivergence(scope.orgId, runId, row.cost, costUsd, {
    serverPriced,
    // `required` is set by exactly one caller — finalize's terminal ledger
    // barrier — which is what makes it this producer's once-per-run hook.
    terminal: opts.required === true,
  });

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
 * Does the platform price this run itself, or pass the runner's number through?
 *
 * A non-NULL `model_source` means the platform resolved a model for this run and
 * therefore holds its rates (`runs.model_cost`) — it prices the row. A NULL one
 * is the REMOTE-origin signature (the run resolved no platform model — the same
 * fact `notRunnerMirrorSql` keys on): there are no server-side rates to compute
 * with, so the runner's own figure is all there is.
 */
function costIsServerComputed(modelSource: string | null | undefined): boolean {
  return coerceCredentialSource(modelSource) !== null;
}

/** A runner row's cost and the provenance verdict on that cost. */
interface RunnerCostVerdict {
  costUsd: number;
  pricingStatus: TokenPricingStatus | null;
}

/**
 * Price a runner row SERVER-SIDE, and classify what that price is worth.
 *
 * **Why the platform recomputes instead of recording what the container sent.**
 * The `cost` on an `appstrate.metric` event is produced INSIDE the agent
 * container: the Pi SDK multiplies its own token counters by the rates the
 * platform handed it in `MODEL_COST`. Recording it made the sandbox the platform
 * is isolating the author of the number billing debits credits from
 * (`llm_usage.cost_usd` is the only input the cloud module bills off). The
 * platform already holds both factors — the kickoff rate snapshot
 * `runs.model_cost` and the token counts the runner reports — so it computes the
 * product itself and the container's figure becomes advisory.
 *
 * It also unblocks masking `MODEL_COST` for aliased models: the published rate
 * card identifies the vendor an alias exists to hide, and a container with no
 * rates reports cost 0. With the cost computed here, dropping that env var
 * changes nothing about what the run is billed.
 *
 * **One formula, three callers.** `computeTokenCost` (`@appstrate/afps-runtime/
 * runner`) is the shared four-bucket definition the LLM-proxy meter already
 * delegates to (`llm-proxy/metering.ts:computeCostUsd`) precisely so the two
 * meters cannot drift; this is the third caller, not a fourth spelling.
 *
 * **BILLING BEHAVIOUR CHANGE — abnormally terminated runs now cost money.** This
 * is the one revenue-affecting consequence of the recompute, and it is not
 * visible from any single line of the diff. A run that dies without posting
 * terminal usage (watchdog kill, container crash, timeout, cancel) is finalized
 * from a synthesised `RunResult` that carries NO `cost`, so under the previous
 * `costUsd: row.cost ?? 0` those runs settled at exactly $0 — even though
 * finalize was already preserving their last cumulative token snapshot from
 * `runs.tokenUsage` (`readLastKnownUsage`). That snapshot is now priced like any
 * other, so those runs bill their real consumption. That is the correct
 * behaviour — the tokens were genuinely spent with the provider and the platform
 * holds the rates — but it means credit debits appear where a deploy of this
 * change previously produced none, and a crash-heavy tenant will see its bill
 * rise without its usage having changed. Pinned by "a run that DIED without
 * terminal usage is still priced, from its preserved snapshot"
 * (`test/integration/services/llm-usage-settlement.test.ts`).
 *
 * **Monotonicity is preserved.** The upsert (`onConflict: "runner-monotonic"`)
 * silently discards a snapshot whose cost went DOWN, so a recomputed value must
 * never regress. It cannot: the runner reports CUMULATIVE counters, the rates
 * are a per-run constant snapshotted at kickoff, and `computeTokenCost` is a
 * non-negative linear combination of the counters — so the product is
 * non-decreasing over the sequence. Recomputing from a per-event DELTA would
 * break exactly this and must never be done here.
 *
 * **Cost and status come from ONE set of inputs**, deliberately in one function.
 * Two things depend on it. First, the remote-origin short-circuit governs both
 * halves at once: a NULL `model_source` yields a `null` status (the platform
 * makes no claim — that run's inference is accounted elsewhere, typically as
 * proxy rows carrying their own status; stamping `unpriced` would mislabel every
 * remote run) AND the pass-through cost, because "no rates" is the same fact in
 * both. Second, the snapshot is a JSONB column, so it is NARROWED rather than
 * trusted: a malformed `model_cost` (hand-edited, or an older shape) must yield
 * `unpriced` — `classifyTokenPricing` only probes `cost == null` and
 * `cost.cacheRead`, so an unvalidated `{}` would sail through as fully priced —
 * and the SAME narrowing must feed the arithmetic, or `computeTokenCost` would
 * multiply by an absent `input` rate and write `NaN` into the ledger.
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
      // The run's model label is not part of the sink context, so the warn line
      // is keyed on the org alone (one line per org+status per process) and names
      // the run instead — `runs.model_label` is one lookup away, and the ledger
      // column is the complete, queryable record either way.
      model: null,
      usage,
      cost: rates,
      context: { source: "runner", runId },
    }),
  };
}

/**
 * Tolerance below which the container's figure and the server's are "the same
 * number". One millionth of a dollar: far above IEEE-754 noise from summing the
 * same products in a different order (the container adds per-turn costs, the
 * server multiplies cumulative counters), far below any real formula
 * disagreement — a single mispriced bucket moves a run by orders of magnitude
 * more.
 */
const REPORTED_COST_DIVERGENCE_USD = 1e-6;

/**
 * CUTOVER INSTRUMENT — delete once the recompute has been observed clean in
 * production, together with the container's `cost` on the event envelope.
 *
 * The container still reports its own cost, and the two numbers come from the
 * same rates via two independent implementations. They agree today — pinned by
 * `apps/api/test/unit/runner-cost-parity.test.ts` — but Pi's `calculateCost`
 * carries two branches `computeTokenCost` has no equivalent for: volume tiers,
 * and Anthropic 1h cache writes priced at 2× the INPUT rate. Neither is
 * reachable as the platform configures things (`ModelCost` cannot express tiers;
 * the platform never requests long cache retention), which is exactly why a
 * config change could reopen the gap without anyone editing a formula. The
 * server number stays authoritative regardless; this line is the only signal
 * that the two disagree on real traffic — and it is all there is: no metric, no
 * table, no flag to switch back.
 *
 * **Exactly one line per run, carrying the FULL gap.** The two properties are in
 * tension and the terminal write resolves both: the counters are cumulative, so
 * the run's terminal snapshot holds the largest divergence the run ever had, and
 * every mid-run metric event's gap is a strict prefix of it — information a
 * second line cannot add. Logging per snapshot would emit one line per metric
 * event, and the condition that makes this fire at all is a formula break, which
 * by construction hits EVERY platform run at once: the instrument would bury the
 * incident it exists to report.
 *
 * Gating on the terminal write rather than on a `warnedKeys` set (the precedent
 * in `pricing-provenance.ts`) is deliberate and is NOT a second policy — it is
 * the same "once per unit of work", implemented with the hook this producer
 * happens to have and that one does not. A runner row has a defined last write;
 * a per-call proxy row has none, which is exactly why that file must remember
 * what it has already said. Keying on the terminal write costs no state, no cap,
 * no per-process/per-replica caveat, and cannot report a small early gap as if
 * it were the whole story.
 *
 * The one blind spot this accepts: a platform-synthesised terminal (stall
 * watchdog, crash, cancel) carries no `result.cost`, so a run that died reports
 * nothing here. That is not a lost signal — the container never stated a
 * terminal cost for those runs, so there is no second number to disagree with.
 */
function warnOnReportedCostDivergence(
  orgId: string,
  runId: string,
  reportedCostUsd: number | null,
  costUsd: number,
  at: { serverPriced: boolean; terminal: boolean },
): void {
  // A mid-run metric event. Its gap is a prefix of the terminal one — see above.
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
