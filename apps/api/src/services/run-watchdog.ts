// SPDX-License-Identifier: Apache-2.0

/**
 * Runner liveness watchdog — the unified stall-detection path for every
 * runner topology.
 *
 * Every run (platform container, remote CLI, GitHub Action, …) bumps
 * `runs.last_heartbeat_at` through the shared write-points:
 *   - `persistEventAndAdvance` on every ingested event
 *   - `PATCH /sink/extend` on every idle keep-alive
 * Both touch the same column; neither introduces a branch based on
 * `run_origin`, so liveness stays protocol-symmetric.
 *
 * This service sweeps open-sink rows whose heartbeat slipped past the
 * stall threshold, and routes each one through the same
 * {@link finalizeRun} used by natural termination and container-exit
 * synthesis. `finalizeRun`'s CAS on `sink_closed_at IS NULL` makes the
 * sweep race-safe against a late event POST or the platform's own
 * container-exit synthesis path:
 *
 *   watchdog sweep          ┐
 *   container waitForExit   ├─► finalizeRun (CAS) ─► exactly once
 *   container-posted finalize┘
 *
 * Multi-replica safety: wrapping the sweep in
 * `pg_try_advisory_lock(bigint)` means only one replica runs the
 * scan at a time. `try_*` is non-blocking — the losers simply skip the
 * tick. The CAS inside `finalizeRun` is still the final gate; the lock
 * just keeps the system quiet (no redundant scans, no duplicated log
 * noise) under normal conditions.
 *
 * PGlite (embedded mode) does not implement advisory locks, so the
 * sweep falls back to the lock-free path — fine because embedded mode
 * is single-process by definition.
 */

import { and, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, isEmbeddedDb } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { finalizeRun, getRunSinkContext } from "./run-event-ingestion.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Stable 64-bit identifier for the advisory lock so concurrent replicas
 * share the same lock — any constant would do, but a fixed literal
 * makes accidental collisions with other services visible in
 * `pg_locks`. Do not reuse for any other sweep.
 */
const WATCHDOG_ADVISORY_LOCK_KEY = 7246811900000001n;

export interface RunWatchdogConfig {
  /** How often the sweep runs, in seconds. */
  readonly intervalSeconds: number;
  /** How long a runner can be silent before it's considered stalled, in seconds. */
  readonly stallThresholdSeconds: number;
  /**
   * Hard cap on rows finalised per tick — a safety valve against a
   * cascade of failures hitting thousands of runs at once. Extra rows
   * land in the next tick.
   */
  readonly maxFinalizesPerTick: number;
}

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function startRunWatchdog(config: RunWatchdogConfig): Promise<void> {
  stopped = false;
  logger.info("run watchdog started", {
    intervalSeconds: config.intervalSeconds,
    stallThresholdSeconds: config.stallThresholdSeconds,
  });
  scheduleNext(config);
}

export async function stopRunWatchdog(): Promise<void> {
  stopped = true;
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function scheduleNext(config: RunWatchdogConfig): void {
  if (stopped) return;
  // Small per-replica jitter (±15%) on the tick interval keeps multi-
  // replica deployments from hammering the advisory lock in lockstep.
  const jitter = 1 + (Math.random() - 0.5) * 0.3;
  const delayMs = Math.round(config.intervalSeconds * 1000 * jitter);
  watchdogTimer = setTimeout(() => {
    void runWatchdogTick(config).finally(() => scheduleNext(config));
  }, delayMs);
}

/**
 * Single watchdog sweep: find stalled runs, finalize each as `failed`,
 * return the number of rows finalized. Exported for tests — production
 * code calls {@link startRunWatchdog} which schedules ticks on a loop.
 */
export async function runWatchdogTick(config: RunWatchdogConfig): Promise<number> {
  // Candidate collection is always a SELECT — in PostgreSQL mode we
  // wrap it in a transaction that tries the xact-lock first so
  // concurrent replicas don't duplicate scans. Session-scoped locks
  // don't work under postgres.js connection pooling (acquire on
  // connection A, release on connection B, "you don't own this lock"
  // on every other tick); `pg_try_advisory_xact_lock` releases
  // automatically when the tx ends, so the release is implicit and
  // pool-safe. Embedded mode skips the lock entirely — PGlite is
  // single-process by definition.
  //
  // We only hold the lock long enough to collect the candidate IDs;
  // the actual `finalizeRun()` work happens outside the transaction
  // because each finalize opens its own connections for updates,
  // log appends, memory inserts, and webhook dispatch. The CAS on
  // `sink_closed_at IS NULL` inside finalizeRun is the ultimate
  // exactly-once guarantee — the advisory lock is belt-and-suspenders
  // to keep multi-replica log volume sane.
  let candidateIds: string[];
  try {
    candidateIds = await collectCandidates(config);
  } catch (err) {
    logger.error("run watchdog sweep failed", {
      error: getErrorMessage(err),
    });
    return 0;
  }

  if (candidateIds.length === 0) return 0;

  let finalized = 0;
  for (const id of candidateIds) {
    try {
      await finalizeStalledRun(id, config.stallThresholdSeconds);
      finalized++;
    } catch (err) {
      logger.error("run watchdog failed to finalize stalled run", {
        runId: id,
        error: getErrorMessage(err),
      });
    }
  }

  if (finalized > 0) {
    logger.warn("run watchdog finalized stalled runs", {
      count: finalized,
      stallThresholdSeconds: config.stallThresholdSeconds,
    });
  }
  return finalized;
}

async function collectCandidates(config: RunWatchdogConfig): Promise<string[]> {
  const cutoff = new Date(Date.now() - config.stallThresholdSeconds * 1000);

  const selectCandidates = (executor: {
    select: typeof db.select;
  }): ReturnType<typeof db.select> => {
    return executor.select({ id: runs.id });
  };

  if (isEmbeddedDb) {
    const rows = await selectCandidates(db)
      .from(runs)
      .where(
        and(
          isNull(runs.sinkClosedAt),
          isNotNull(runs.sinkExpiresAt),
          lt(runs.lastHeartbeatAt, cutoff),
        ),
      )
      .limit(config.maxFinalizesPerTick);
    return rows.map((r) => (r as { id: string }).id);
  }

  return await db.transaction(async (tx) => {
    const raw = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${String(WATCHDOG_ADVISORY_LOCK_KEY)}::bigint) AS acquired`,
    );
    const lockRows = raw as unknown as Array<{ acquired: boolean }>;
    if (!lockRows[0]?.acquired) return [];

    const rows = await selectCandidates(tx)
      .from(runs)
      .where(
        and(
          isNull(runs.sinkClosedAt),
          isNotNull(runs.sinkExpiresAt),
          lt(runs.lastHeartbeatAt, cutoff),
        ),
      )
      .limit(config.maxFinalizesPerTick);
    return rows.map((r) => (r as { id: string }).id);
  });
}

async function finalizeStalledRun(runId: string, stallThresholdSeconds: number): Promise<void> {
  const run = await getRunSinkContext(runId);
  if (!run) return;
  // A run that was finalized between the SELECT and this point is
  // handled inside finalizeRun — the CAS on `sink_closed_at IS NULL`
  // makes this call a no-op. We don't gate here to keep the convergence
  // point identical to every other finalize path.

  const result = emptyRunResult();
  result.status = "failed";
  result.error = {
    message: `Runner stopped reporting — no heartbeat for ${stallThresholdSeconds}s. The runner process may have crashed or lost network connectivity.`,
  };

  await finalizeRun({ run, result });
}
