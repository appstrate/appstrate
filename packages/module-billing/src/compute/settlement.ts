// SPDX-License-Identifier: Apache-2.0

/**
 * Settlement of compute minutes: the sweep that turns finished runs into the per-org monthly
 * counter the quota is read from.
 *
 * Shape (the same as the `llm_usage` sweep, adapted to a table with no serial id): a
 * `(completed_at, run_id)` watermark (`ee_compute_cursor`) over
 * `PlatformServices.runs.listTerminal`; each run is CLAIMED exactly once
 * (`ee_settled_runs`, primary key + `ON CONFLICT DO NOTHING RETURNING`); and the claims, the
 * counter increments and the watermark advance of a batch commit in ONE transaction. A failed
 * pass advances nothing and the next one retries.
 *
 * - **Idempotent.** The claim is the arbiter: a run re-read by the replay window, by another
 *   replica or after a restart is counted once. The watermark is monotonic and safe to rewind.
 * - **No run lost to the commit race.** A run's `completed_at` is stamped before the
 *   transaction that closes it commits, so a row can become visible below the watermark.
 *   Every pass re-reads a bounded window (`REPLAY_WINDOW_MS`) below it; the claims make the
 *   re-read free of double counting. A run that stays invisible longer than the window is
 *   the one case this cannot recover: the window is generous against a transaction that
 *   lasts milliseconds.
 * - **Triggered, and also swept.** A terminal `onRunStatusChange` calls
 *   {@link requestSettlement} so the gauge follows the run; the timer
 *   ({@link startComputeSweeper}) is the catch-up that does not depend on an event arriving.
 */

import { and, eq, sql } from "drizzle-orm";
import type { TerminalRunRow } from "@appstrate/core/module";
import { getBillingDb, type BillingTx } from "../db.ts";
import { computeCursor, computeUsage, settledRuns } from "../../drizzle/schema.ts";
import { getPlatformServices } from "../platform.ts";
import { logger } from "../logger.ts";
import { billableSeconds, periodStartOf } from "./period.ts";
import { emitComputeSignals, type ComputeIncrement } from "./alerts.ts";
import { purgeOrphanedOrgs } from "./orphans.ts";

/** How far below the watermark a pass re-reads, to catch a run that committed late. */
export const REPLAY_WINDOW_MS = 10 * 60 * 1000;

const DEFAULT_BATCH_SIZE = 500;
/** Bounds one pass: a backlog beyond this rides the next tick. */
const DEFAULT_MAX_BATCHES = 50;

interface SettlementOptions {
  batchSize?: number;
  maxBatches?: number;
  replayWindowMs?: number;
}

interface SettlementResult {
  /** Terminal runs read, re-reads of already-settled ones included. */
  read: number;
  /** Runs claimed for the first time by this pass. */
  settled: number;
  /** Seconds added to the counters by this pass. */
  seconds: number;
}

/**
 * One increment per (org, month), not per run (a burst of short runs is one write), in a
 * FIXED order: two replicas settling disjoint batches that touch the same orgs upsert the same
 * counter rows, and doing so in opposite orders is a deadlock Postgres resolves by aborting
 * one of them. Sorting makes every batch take the row locks in the same order.
 */
export function aggregateByOrgAndMonth(
  claimed: readonly { orgId: string; periodStart: string; seconds: number }[],
): { orgId: string; periodStart: string; seconds: number }[] {
  const delta = new Map<string, { orgId: string; periodStart: string; seconds: number }>();
  for (const row of claimed) {
    if (row.seconds <= 0) continue;
    const key = `${row.orgId}|${row.periodStart}`;
    const entry = delta.get(key) ?? { orgId: row.orgId, periodStart: row.periodStart, seconds: 0 };
    entry.seconds += row.seconds;
    delta.set(key, entry);
  }
  return [...delta.values()].sort(
    (a, b) =>
      (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0) ||
      (a.periodStart < b.periodStart ? -1 : 1),
  );
}

/** Settle one batch: claim, count, advance — one transaction. Returns what it added. */
async function settleBatch(
  tx: BillingTx,
  batch: readonly TerminalRunRow[],
): Promise<{ settled: number; increments: ComputeIncrement[] }> {
  const claimed = await tx
    .insert(settledRuns)
    .values(
      batch.map((run) => ({
        runId: run.id,
        orgId: run.orgId,
        seconds: billableSeconds(run),
        periodStart: periodStartOf(run.completedAt),
      })),
    )
    .onConflictDoNothing({ target: settledRuns.runId })
    .returning({
      orgId: settledRuns.orgId,
      seconds: settledRuns.seconds,
      periodStart: settledRuns.periodStart,
    });

  const increments: ComputeIncrement[] = [];
  for (const { orgId, periodStart, seconds } of aggregateByOrgAndMonth(claimed)) {
    const [row] = await tx
      .insert(computeUsage)
      .values({ orgId, periodStart, secondsUsed: seconds })
      .onConflictDoUpdate({
        target: [computeUsage.orgId, computeUsage.periodStart],
        set: {
          secondsUsed: sql`${computeUsage.secondsUsed} + ${seconds}`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ secondsUsed: computeUsage.secondsUsed });
    increments.push({ orgId, periodStart, addedSeconds: seconds, secondsUsed: row!.secondsUsed });
  }

  // Forward only: the pair comparison keeps a replayed batch (older than the watermark) from
  // dragging it back, and two replicas from overwriting each other with an older pair.
  const last = batch[batch.length - 1]!;
  await tx
    .update(computeCursor)
    .set({ completedAt: last.completedAt, runId: last.id, updatedAt: sql`now()` })
    .where(
      and(
        eq(computeCursor.id, true),
        sql`(${computeCursor.completedAt}, ${computeCursor.runId}) < (${last.completedAt.toISOString()}::timestamptz, ${last.id})`,
      ),
    );

  return { settled: claimed.length, increments };
}

/**
 * Create the watermark if it does not exist yet, positioned so the first pass starts at `now`. Called by `init()`, after the
 * migration and before the first pass: a run that finished before the module metered compute
 * is not billed retroactively, and a run still in flight at that moment settles when it ends.
 * Idempotent and race-safe (`ON CONFLICT DO NOTHING`); a warm boot is a no-op, so a module
 * that was off for a while resumes from where it stopped and settles the gap.
 */
export async function ensureComputeCursorSeeded(): Promise<void> {
  // Dated one replay window AHEAD: a pass reads from `watermark - window`, so a watermark at
  // `now` would reach back and bill the runs of the ten minutes before the module was
  // enabled. At `now + window` the first pass starts exactly at `now`.
  await getBillingDb()
    .insert(computeCursor)
    .values({ completedAt: new Date(Date.now() + REPLAY_WINDOW_MS), runId: "" })
    .onConflictDoNothing({ target: computeCursor.id });
}

/** One settlement pass: drain finished runs from the replay point forward. */
export async function settleTerminalRuns(
  options: SettlementOptions = {},
): Promise<SettlementResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const replayWindowMs = options.replayWindowMs ?? REPLAY_WINDOW_MS;
  const db = getBillingDb();

  const [cursor] = await db.select().from(computeCursor).where(eq(computeCursor.id, true));
  if (!cursor) {
    // `init()` seeds it; a missing row is a database restored without it. Refuse to guess a
    // starting point (zero would bill the whole history at once).
    throw new Error("ee_compute_cursor is empty: the module's init() seeds its single row");
  }

  let after: { completedAt: Date; id: string } = {
    completedAt: new Date(cursor.completedAt.getTime() - replayWindowMs),
    id: "",
  };
  const result: SettlementResult = { read: 0, settled: 0, seconds: 0 };
  const increments: ComputeIncrement[] = [];

  for (let i = 0; i < maxBatches; i++) {
    const batch = await getPlatformServices().runs.listTerminal({ after, limit: batchSize });
    if (batch.length === 0) break;
    const settled = await db.transaction((tx) => settleBatch(tx, batch));
    result.read += batch.length;
    result.settled += settled.settled;
    for (const inc of settled.increments) {
      result.seconds += inc.addedSeconds;
      increments.push(inc);
    }
    const last = batch[batch.length - 1]!;
    after = { completedAt: last.completedAt, id: last.id };
    if (batch.length < batchSize) break;
  }

  // After every commit, and never allowed to fail the pass: the counters are already durable.
  if (increments.length > 0) emitComputeSignals(increments);
  return result;
}

// ---------------------------------------------------------------------------
// Triggering: the event pokes a pass, the timer is the catch-up
// ---------------------------------------------------------------------------

let inFlight: Promise<void> | null = null;
let rerun = false;
/** A pass that must re-read the replay window was asked for while another was running. */
let replayRequested = false;

/**
 * Run a settlement pass, single-flight per process. Only the timer's pass (`replay`) re-reads
 * the window below the watermark: it is what recovers a run that committed late, once a
 * minute, instead of every terminal event re-reading and re-claiming the whole window. A pass
 * triggered by an event starts at the watermark. A call made during a pass a call during a pass asks for one more
 * pass when it ends instead of stacking a second concurrent one, and shares the promise of the
 * one in flight. Never rejects: a failing pass is logged, and the next trigger or the timer
 * repairs it.
 */
function settleSingleFlight(replay: boolean): Promise<void> {
  if (replay) replayRequested = true;
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerun = false;
      const replayWindowMs = replayRequested ? REPLAY_WINDOW_MS : 0;
      replayRequested = false;
      try {
        await settleTerminalRuns({ replayWindowMs });
      } catch (err) {
        logger.error("compute settlement failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    } while (rerun);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Settle soon, from a terminal `onRunStatusChange`. Fire-and-forget: an event handler must not
 * fail a run's finalize, and the sweep timer repairs whatever this missed.
 */
export function requestSettlement(): void {
  void settleSingleFlight(false);
}

/** Test-only: await the pass a {@link requestSettlement} started, if any. */
export async function _awaitSettlementForTests(): Promise<void> {
  while (inFlight) await inFlight;
}

// ---------------------------------------------------------------------------
// The catch-up timer
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
/** How long `shutdown()` waits for a pass before letting the DB pool close anyway. */
const DRAIN_TIMEOUT_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let sweepIntervalMs = SWEEP_INTERVAL_MS;

/** Ticks between two purges of deleted organizations' rows: hourly at a 60 s cadence. */
const PURGE_EVERY_TICKS = 60;
let ticks = 0;

async function maybePurgeOrphans(): Promise<void> {
  if (++ticks % PURGE_EVERY_TICKS !== 0) return;
  try {
    await purgeOrphanedOrgs();
  } catch (err) {
    logger.error("compute orphan purge failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function scheduleNext(): void {
  if (stopped) return;
  const jitter = 0.9 + Math.random() * 0.2;
  timer = setTimeout(() => {
    // Shares the event-poked passes' single flight, so a tick and an event never both read
    // and claim the same window.
    void settleSingleFlight(true).then(maybePurgeOrphans).finally(scheduleNext);
  }, sweepIntervalMs * jitter);
  // A trailing tick must not keep the process alive.
  timer.unref?.();
}

/** Arm the catch-up sweep, every `intervalMs` (a test shortens it). Idempotent. */
export function startComputeSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (!stopped) return;
  stopped = false;
  sweepIntervalMs = intervalMs;
  scheduleNext();
}

/** Stop scheduling new passes. In-flight work is awaited by {@link drainComputeSweeper}. */
export function stopComputeSweeper(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Let an in-flight pass finish before the DB pool closes, for at most `DRAIN_TIMEOUT_MS`:
 * a wedged pass rolls back on its own and loses nothing (the claims make the next pass redo
 * it), so shutdown must not hang on it.
 */
export async function drainComputeSweeper(timeoutMs: number = DRAIN_TIMEOUT_MS): Promise<void> {
  if (!inFlight) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    inFlight,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, timeoutMs);
      deadline.unref?.();
    }),
  ]);
  if (deadline) clearTimeout(deadline);
}
