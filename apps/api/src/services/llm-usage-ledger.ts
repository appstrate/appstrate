// SPDX-License-Identifier: Apache-2.0

/**
 * Single writer of the append-only `llm_usage` ledger.
 *
 * Every producer — the inference proxy (`llm-proxy/metering.ts`), the agent
 * runner sink (`run-launcher/appstrate-event-sink.ts`) and the subscription
 * chat engine seam (`chat-subscription.ts`) — inserts through {@link
 * recordLlmUsage} instead of building its own `db.insert(llmUsage)`. What is
 * unified here so it can't drift:
 *
 *   - the column mapping + the ledger check-constraint invariants (a proxy row
 *     carries a `request_id`; a row is attributed to at most one context). This
 *     writer is also the sole guarantor of the runner-row birth invariant: a
 *     `source: "runner"` row is ALWAYS inserted with a non-null `runId` (from
 *     the run's own id — see the runner-monotonic upsert below, keyed on
 *     `run_id`). The DB no longer enforces it with a CHECK (dropped in
 *     migration 0028) because a run deletion legitimately detaches the row to
 *     `run_id = NULL` afterwards; the at-insert invariant lives here instead.
 *
 * The ledger is a PULL surface for modules: `PlatformServices.usage.list` /
 * `usage.settledFrontier` sweep it by serial-`id` cursor. There is no
 * per-row push notification — a broadcast could not be relied upon anyway (a
 * cumulative runner row re-fires under one id, handler errors are isolated),
 * so a consumer that must not miss spend has to read the cursor regardless.
 *
 * Runner-row write contract (the one mutable row shape on the ledger):
 *
 *   - ONE row per run, upserted monotonically — its `cost_usd` may only grow;
 *   - it stops being writable the instant its run reaches a terminal status,
 *     because that is exactly when a billing cursor may claim it by serial id
 *     (`state/runs.ts:settledSql`). A later snapshot is REFUSED and logged as a
 *     billing loss rather than applied to a claimed row — see
 *     {@link runNotTerminalSql};
 *   - consequently a runner write is never deferred to the durable retry queue
 *     (`llm-usage-retry.ts`): an asynchronous replay could only land after the
 *     run settled. Runner snapshots are cumulative, so a failed write is
 *     repaired by the next metric event or by finalize's terminal barrier.
 *
 * It is intentionally a thin insert seam, not a framework: cost is already
 * computed by each caller (they own the token→USD arithmetic and persistence
 * policy), and the runner's monotonic upsert is expressed as one opt-in flag
 * rather than a second code path. Billable producers wrap this with
 * `llm-usage-retry.ts` for durable recovery.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import { db, type Db } from "@appstrate/db/client";
import { llmUsage, runs, terminalRunStatusValues } from "@appstrate/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { logger } from "../lib/logger.ts";

/** Credential set that reached the upstream provider for a ledger row. */
export type CredentialSource = "system" | "org";

/**
 * One `llm_usage` row to append. Covers every producer's needs; unset optional
 * fields insert as NULL / their column default. The caller supplies the already
 * computed {@link costUsd} — this service performs no pricing arithmetic.
 */
export interface LlmUsageEntry {
  source: "proxy" | "runner";
  orgId: string;
  /** Set for a JWT-authenticated user principal. */
  userId?: string | null;
  /** Set for an API-key principal. */
  apiKeyId?: string | null;
  /** Run attribution — mutually exclusive with {@link chatSessionId}. */
  runId?: string | null;
  /** Chat-session attribution — mutually exclusive with {@link runId}. */
  chatSessionId?: string | null;
  /** Preset id (org model row id) the caller selected — stored as `llm_usage.model`. */
  model?: string | null;
  /** Real upstream model id — SERVER-SIDE ONLY, never exposed to modules. */
  realModel?: string | null;
  /** Protocol family (`anthropic-messages`, …) — SERVER-SIDE ONLY. */
  api?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd: number;
  durationMs?: number | null;
  /** Proxy dedup key — required on proxy rows, null on runner rows. */
  requestId?: string | null;
  /** Which credential set reached the provider. */
  credentialSource?: CredentialSource | null;
}

export interface RecordLlmUsageOptions {
  /** Executor to insert with — pass a transaction on the runner ingestion path. */
  executor?: Db;
  /**
   * When set, INSERT with the runner's monotonic upsert against the partial
   * unique index `uq_llm_usage_runner_run_id` (at most one runner row per run;
   * the highest cumulative cost wins). The plain insert (proxy / chat) omits it.
   */
  onConflict?: "runner-monotonic" | "proxy-idempotent";
}

/**
 * SQL guard: the conflicting runner row's run is NOT terminal yet.
 *
 * Post-settlement immutability (the runner row's write contract). A runner row
 * is ONE cumulative row per run, and a billing consumer claims it by its serial
 * `id` the moment it is `settled` — which `state/runs.ts:settledSql` defines as
 * "its run reached a terminal status". A serial id is claimed exactly once and
 * never revisited, so an UPDATE landing after that instant raises a total nobody
 * will ever re-read: the delta is silently un-billed.
 *
 * The upsert therefore refuses to mutate a row whose run is already terminal,
 * using the SAME status predicate as `settledSql` so the two can never drift.
 * Ordering makes this a narrow window rather than a functional restriction: the
 * `appstrate.metric` ingestion path writes inside the transaction that CASes on
 * `sink_closed_at IS NULL` (a post-close event never reaches the ledger at all),
 * and `finalizeRun` writes its terminal snapshot BEFORE its own CAS. What is
 * left is a genuine concurrent-finalize race (two termination paths for the same
 * run), and it is reported as a billing-loss error rather than applied blindly.
 *
 * The structurally lossless alternative — inserting the delta as a NEW ledger
 * row so it gets a fresh, sweepable id — is blocked by the partial unique index
 * `uq_llm_usage_runner_run_id` (at most one runner row per run) and needs a
 * migration; see `docs/architecture/RUN_COST.md`.
 */
const runNotTerminalSql = sql`NOT EXISTS (
  SELECT 1 FROM ${runs}
  WHERE ${runs.id} = ${llmUsage.runId}
    AND ${runs.status} IN (${sql.join(
      terminalRunStatusValues.map((s) => sql`${s}`),
      sql`, `,
    )})
)`;

/** The monotonic columns of one runner snapshot, as SQL expressions. */
interface RunnerSnapshotSql {
  costUsd: SQL;
  inputTokens: SQL;
  outputTokens: SQL;
  cacheReadTokens: SQL;
  cacheWriteTokens: SQL;
}

/** The stored side: the conflicting row's own columns. */
const storedSnapshotSql: RunnerSnapshotSql = {
  costUsd: sql`${llmUsage.costUsd}`,
  inputTokens: sql`${llmUsage.inputTokens}`,
  outputTokens: sql`${llmUsage.outputTokens}`,
  cacheReadTokens: sql`${llmUsage.cacheReadTokens}`,
  cacheWriteTokens: sql`${llmUsage.cacheWriteTokens}`,
};

/** The candidate side inside an upsert: Postgres' `EXCLUDED` pseudo-row. */
const excludedSnapshotSql: RunnerSnapshotSql = {
  costUsd: sql`EXCLUDED.cost_usd`,
  inputTokens: sql`EXCLUDED.input_tokens`,
  outputTokens: sql`EXCLUDED.output_tokens`,
  cacheReadTokens: sql`EXCLUDED.cache_read_tokens`,
  cacheWriteTokens: sql`EXCLUDED.cache_write_tokens`,
};

/**
 * The same candidate as bound parameters, so {@link runnerAdvancesSql} can be
 * evaluated outside an upsert. Every value is cast: a bound parameter reaches
 * Postgres untyped, and `$1 + $2` alone is not resolvable.
 */
function entrySnapshotSql(entry: LlmUsageEntry): RunnerSnapshotSql {
  return {
    costUsd: sql`${entry.costUsd}::double precision`,
    inputTokens: sql`${entry.inputTokens}::integer`,
    outputTokens: sql`${entry.outputTokens}::integer`,
    cacheReadTokens: sql`${entry.cacheReadTokens ?? null}::integer`,
    cacheWriteTokens: sql`${entry.cacheWriteTokens ?? null}::integer`,
  };
}

/**
 * Cumulative token total of a snapshot — the measure the level-2 tiebreak
 * compares, and the one the refusal diagnostic reports. Shared so the figure an
 * operator reads is by construction the figure the predicate weighed; NULL for
 * an unmatched LEFT JOIN (no stored row), 0-COALESCED per cache arm otherwise.
 */
function snapshotTotalTokensSql(snapshot: RunnerSnapshotSql): SQL<number | null> {
  return sql<number | null>`(
    ${snapshot.inputTokens} + ${snapshot.outputTokens}
      + COALESCE(${snapshot.cacheReadTokens}, 0)
      + COALESCE(${snapshot.cacheWriteTokens}, 0)
  )`;
}

/**
 * SQL predicate: `candidate` strictly ADVANCES the conflicting runner row.
 *
 * Runner rows are cumulative snapshots — tokens and cost grow together — so the
 * row must only ever advance:
 *   1. a strictly higher cumulative cost wins; else
 *   2. an EQUAL cost with a strictly higher total token count wins.
 * Level 2 is what keeps a zero-cost model (free model / no catalog rate /
 * zero-rate tokens) correct: its cost stays constant at 0 while token counts
 * keep climbing, so a cost-only rule would freeze the token columns at their
 * first values. Both levels use STRICT inequalities, so an exact duplicate
 * replay (same cost AND same tokens) is a no-op that re-emits nothing — that
 * idempotence is load-bearing for cursor consumers. Out-of-order metric events
 * and the finalize fallback can never regress either dimension.
 *
 * Built once for the two sites that MUST agree on it: the upsert's `setWhere`
 * (candidate = {@link excludedSnapshotSql}) and the refusal diagnostic
 * {@link traceRejectedTerminalRunnerWrite} (candidate = the entry's bound
 * values), so the diagnostic can never contradict the write it explains.
 * Evaluates to NULL when there is no row to compare against (an unmatched LEFT
 * JOIN) — the diagnostic reads that as "would have inserted".
 */
function runnerAdvancesSql(candidate: RunnerSnapshotSql): SQL<boolean | null> {
  return sql<boolean | null>`(
    ${candidate.costUsd} > ${storedSnapshotSql.costUsd}
    OR (
      ${candidate.costUsd} = ${storedSnapshotSql.costUsd}
      AND ${snapshotTotalTokensSql(candidate)} > ${snapshotTotalTokensSql(storedSnapshotSql)}
    )
  )`;
}

/**
 * Append one row to `llm_usage`.
 *
 * Returns the new row's serial `id`, or `null` when a runner-monotonic upsert
 * was a no-op (an equal-or-lower cumulative total lost the conflict). DB errors
 * are NOT swallowed here — each caller decides whether to fail, retry, or
 * durably enqueue.
 */
export async function recordLlmUsage(
  entry: LlmUsageEntry,
  opts: RecordLlmUsageOptions = {},
): Promise<number | null> {
  // Birth invariant, enforced HERE since migration 0028 dropped the
  // `llm_usage_runner_has_run_id` CHECK (a detached row legitimately has
  // run_id NULL, so the DB can no longer distinguish birth from detach): a
  // runner row without a run would dodge the monotonic partial unique index
  // (`WHERE source = 'runner' AND run_id IS NOT NULL`), turning every
  // cumulative snapshot into a fresh, immediately-settled row — overbilling.
  if (entry.source === "runner" && !entry.runId) {
    throw new Error("recordLlmUsage: a runner row must be born with a runId");
  }
  const executor = opts.executor ?? db;
  const values = {
    source: entry.source,
    orgId: entry.orgId,
    apiKeyId: entry.apiKeyId ?? null,
    userId: entry.userId ?? null,
    runId: entry.runId ?? null,
    chatSessionId: entry.chatSessionId ?? null,
    model: entry.model ?? null,
    realModel: entry.realModel ?? null,
    api: entry.api ?? null,
    credentialSource: entry.credentialSource ?? null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? null,
    cacheWriteTokens: entry.cacheWriteTokens ?? null,
    costUsd: entry.costUsd,
    durationMs: entry.durationMs ?? null,
    requestId: entry.requestId ?? null,
  };

  const inserted =
    opts.onConflict === "runner-monotonic"
      ? await executor
          .insert(llmUsage)
          .values(values)
          // Two-level monotonic upsert on the partial unique index — see
          // {@link runnerAdvancesSql} for the advance rule. Token columns are
          // bumped alongside the cost so the snapshot stays consistent.
          .onConflictDoUpdate({
            target: llmUsage.runId,
            targetWhere: sql`source = 'runner' AND run_id IS NOT NULL`,
            set: {
              inputTokens: sql`EXCLUDED.input_tokens`,
              outputTokens: sql`EXCLUDED.output_tokens`,
              cacheReadTokens: sql`EXCLUDED.cache_read_tokens`,
              cacheWriteTokens: sql`EXCLUDED.cache_write_tokens`,
              costUsd: sql`EXCLUDED.cost_usd`,
            },
            // The monotonic advance is additionally gated on the run still
            // being non-terminal — see {@link runNotTerminalSql}: a settled row
            // has already been claimed by its serial id, so growing it strands
            // the delta.
            setWhere: sql`${runNotTerminalSql} AND ${runnerAdvancesSql(excludedSnapshotSql)}`,
          })
          .returning({ id: llmUsage.id })
      : opts.onConflict === "proxy-idempotent"
        ? await executor
            .insert(llmUsage)
            .values(values)
            // A DB client can lose the INSERT acknowledgement after Postgres
            // committed it. Durable retry replays the exact same request_id;
            // the partial unique index turns that uncertain outcome into a
            // clean no-op instead of a duplicate ledger row.
            .onConflictDoNothing({
              target: llmUsage.requestId,
              where: sql`source = 'proxy' AND request_id IS NOT NULL`,
            })
            .returning({ id: llmUsage.id })
        : await executor.insert(llmUsage).values(values).returning({ id: llmUsage.id });

  const llmUsageId: number | null = inserted[0]?.id ?? null;
  if (llmUsageId === null) {
    // A runner no-op is either a harmless replay (an equal-or-lower cumulative
    // snapshot) or the post-settlement rejection above — which is a real,
    // silent-until-now loss of billable spend and must leave a trace. One PK
    // lookup on the run tells the two apart, and only ever runs on a no-op.
    if (entry.source === "runner" && entry.runId) {
      await traceRejectedTerminalRunnerWrite(executor, entry);
    }
    return null;
  }

  return llmUsageId;
}

/**
 * Log the post-settlement rejection of a late runner snapshot (see
 * {@link runNotTerminalSql}) — but ONLY when that snapshot would genuinely have
 * advanced the stored row. Called only when the monotonic upsert wrote nothing,
 * and only for runner rows.
 *
 * A no-op upsert has two unrelated causes: the terminal barrier refused a real
 * delta (billing loss — the error below), or the snapshot was an equal-or-lower
 * cumulative replay with nothing to add (benign — silence). Every successful run
 * produces one of the latter, which is why a status-only test drowned the real
 * losses under one error per run (issue #997): `run-launcher/execute-background.ts`
 * defensively synthesises a finalize on ANY clean container exit, and
 * `synthesiseFinalize` carries no cost, so finalize's terminal ledger barrier
 * re-submits the run's own last snapshot at `costUsd: 0` once the run settled.
 *
 * The advance test is the SAME predicate the upsert gates on
 * ({@link runnerAdvancesSql}), evaluated in Postgres against the stored row, so
 * the diagnostic cannot drift from the write it explains — and no comparison
 * value crosses the SQL/TS boundary. Only a definitive `false` is silence: NULL
 * means the run carries no runner row, i.e. the snapshot would have INSERTed, so
 * it is still reported. A run row that vanished (deleted mid-flight) is not a
 * rejection — the conflicting row was detached to `run_id = NULL` and the insert
 * took the plain path.
 */
async function traceRejectedTerminalRunnerWrite(executor: Db, entry: LlmUsageEntry): Promise<void> {
  const incoming = entrySnapshotSql(entry);
  try {
    const [row] = await executor
      .select({
        status: runs.status,
        storedCostUsd: llmUsage.costUsd,
        storedTotalTokens: snapshotTotalTokensSql(storedSnapshotSql),
        incomingTotalTokens: snapshotTotalTokensSql(incoming),
        advances: runnerAdvancesSql(incoming),
      })
      .from(runs)
      .leftJoin(llmUsage, and(eq(llmUsage.runId, runs.id), eq(llmUsage.source, "runner")))
      .where(eq(runs.id, entry.runId!))
      .limit(1);
    if (!row || !(terminalRunStatusValues as readonly string[]).includes(row.status)) return;
    if (row.advances === false) return;
    // BOTH dimensions, because a refusal can lose either one: a zero-cost model
    // holds `cost_usd` flat while tokens climb, so a token-only loss reports
    // three zeroes on the cost side. `refusedDeltaTokens > 0` is what separates
    // it from a benign replay — never `refusedDeltaUsd`.
    logger.error("llm_usage: refused a runner snapshot on an already-settled run", {
      runId: entry.runId,
      orgId: entry.orgId,
      runStatus: row.status,
      storedCostUsd: row.storedCostUsd,
      incomingCostUsd: entry.costUsd,
      refusedDeltaUsd: entry.costUsd - (row.storedCostUsd ?? 0),
      storedTotalTokens: row.storedTotalTokens,
      incomingTotalTokens: row.incomingTotalTokens,
      refusedDeltaTokens: (row.incomingTotalTokens ?? 0) - (row.storedTotalTokens ?? 0),
    });
  } catch (err) {
    // Explaining a no-op must never break the write: `recordLlmUsageReliably`
    // always rethrows for runner rows, and the finalize barrier calls it with
    // `required: true` outside any transaction, so a throw here would fail
    // `finalizeRun` and leave the run unsettled. It stays at `error` because an
    // unassessed refusal may be a real billing loss and a diagnostic that cannot
    // run in a billing path is itself actionable — noisy only if the SELECT
    // breaks systematically, and bounded by a query that runs solely on a no-op.
    // Catching cannot un-poison the `appstrate.metric` caller's ingestion
    // transaction, which stays safe by its own design (the runner's next
    // cumulative snapshot supersedes — see `run-launcher/appstrate-event-sink.ts`).
    logger.error("llm_usage: could not assess a refused runner snapshot", {
      runId: entry.runId,
      orgId: entry.orgId,
      incomingCostUsd: entry.costUsd,
      // Summed in TS, not by {@link snapshotTotalTokensSql}: the DB read is what
      // just failed, so only the entry's own values are still in hand.
      incomingTotalTokens:
        entry.inputTokens +
        entry.outputTokens +
        (entry.cacheReadTokens ?? 0) +
        (entry.cacheWriteTokens ?? 0),
      error: getErrorMessage(err),
    });
  }
}
