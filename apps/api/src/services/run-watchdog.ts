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
 * ## Two phases, two questions
 *
 * The sweep answers two DIFFERENT questions, and conflating them is what
 * used to make it kill healthy runs:
 *
 *   1. **stall** — "the runner went quiet": `last_heartbeat_at` slipped past
 *      `stallThresholdSeconds`. Aggressive, because a live runner beats
 *      every `RUN_HEARTBEAT_INTERVAL_SECONDS`.
 *   2. **boot deadline** — "the runner never showed up": the run still has
 *      `last_event_sequence = 0` and blew its `boot_deadline_at`. Generous,
 *      because provisioning (image pull, boundary create, container boot)
 *      legitimately takes tens of seconds and no runner exists yet to beat.
 *
 * During phase 1 the platform attests liveness on the runner's behalf
 * (`services/run-boot-heartbeat.ts`), so predicate (1) alone would never
 * fire while provisioning is genuinely in progress — and predicate (2) is
 * what stops that attestation from becoming unfalsifiable. Same split as
 * Kubernetes `startupProbe` (generous, gates the rest) vs `livenessProbe`
 * (aggressive, owns steady state). Each predicate finalises with its own
 * error message, so the run detail says what actually happened instead of
 * blaming a runner that never got to exist.
 *
 * This service sweeps open-sink rows matching either predicate, and routes
 * each one through the same
 * {@link finalizeRun} used by natural termination and container-exit
 * synthesis. Each stalled run's workload is also stopped through the
 * orchestrator (same route as user cancel) — fire-and-forget, so a
 * wedged daemon or runtime can never block the finalize — because a
 * stalled runner is not necessarily a dead one (e.g. a firecracker
 * microVM that lost network keeps executing and billing).
 * `finalizeRun`'s CAS on `sink_closed_at IS NULL` makes the
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

import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, isEmbeddedDb } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { logger } from "../lib/logger.ts";
import { applyRecoveredOutput, finalizeRun, getRunSinkContext } from "./run-event-ingestion.ts";
import { stopWorkloadAndWait } from "./stop-workload.ts";
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
  let candidates: WatchdogCandidate[];
  try {
    candidates = await collectCandidates(config);
  } catch (err) {
    logger.error("run watchdog sweep failed", {
      error: getErrorMessage(err),
    });
    return 0;
  }

  if (candidates.length === 0) return 0;

  let finalized = 0;
  for (const candidate of candidates) {
    try {
      await finalizeStalledRun(candidate, config.stallThresholdSeconds);
      finalized++;
    } catch (err) {
      logger.error("run watchdog failed to finalize stalled run", {
        runId: candidate.id,
        reason: candidate.reason,
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

/** Which predicate matched — decides the error the run is finalised with. */
type WatchdogReason = "stall" | "boot-deadline";

interface WatchdogCandidate {
  readonly id: string;
  readonly reason: WatchdogReason;
  /**
   * Provisioning budget the run was given, in seconds — derived per-row
   * (`boot_deadline_at - started_at`) rather than read from the current env
   * so the message stays true for rows created under an older setting.
   * Only set for `boot-deadline` candidates.
   */
  readonly bootBudgetSeconds?: number;
}

async function collectCandidates(config: RunWatchdogConfig): Promise<WatchdogCandidate[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - config.stallThresholdSeconds * 1000);

  // Both predicates in ONE scan: a run can only ever match one of them in
  // practice (the boot pump keeps `last_heartbeat_at` fresh exactly while
  // `last_event_sequence = 0`), but `stall` wins the classification if both
  // somehow hold — a row that has been silent past the stall threshold AND
  // blew its deadline is, from the operator's point of view, a run whose
  // runner went quiet. Each predicate is served by its own partial index.
  const where = and(
    isNull(runs.sinkClosedAt),
    isNotNull(runs.sinkExpiresAt),
    or(
      lt(runs.lastHeartbeatAt, cutoff),
      and(
        eq(runs.lastEventSequence, 0),
        isNotNull(runs.bootDeadlineAt),
        lt(runs.bootDeadlineAt, now),
      ),
    ),
  );

  const selectCandidates = (executor: {
    select: typeof db.select;
  }): ReturnType<typeof db.select> => {
    return executor.select({
      id: runs.id,
      lastHeartbeatAt: runs.lastHeartbeatAt,
      startedAt: runs.startedAt,
      bootDeadlineAt: runs.bootDeadlineAt,
    });
  };

  type CandidateRow = {
    id: string;
    lastHeartbeatAt: Date;
    startedAt: Date;
    bootDeadlineAt: Date | null;
  };

  const classify = (rows: unknown[]): WatchdogCandidate[] =>
    (rows as CandidateRow[]).map((row) => {
      if (row.lastHeartbeatAt.getTime() < cutoff.getTime()) {
        return { id: row.id, reason: "stall" as const };
      }
      const budgetMs = (row.bootDeadlineAt?.getTime() ?? 0) - row.startedAt.getTime();
      return {
        id: row.id,
        reason: "boot-deadline" as const,
        bootBudgetSeconds: Math.max(1, Math.round(budgetMs / 1000)),
      };
    });

  if (isEmbeddedDb) {
    const rows = await selectCandidates(db)
      .from(runs)
      .where(where)
      .limit(config.maxFinalizesPerTick);
    return classify(rows);
  }

  return await db.transaction(async (tx) => {
    const raw = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(${String(WATCHDOG_ADVISORY_LOCK_KEY)}::bigint) AS acquired`,
    );
    const lockRows = raw as unknown as Array<{ acquired: boolean }>;
    if (!lockRows[0]?.acquired) return [];

    const rows = await selectCandidates(tx)
      .from(runs)
      .where(where)
      .limit(config.maxFinalizesPerTick);
    return classify(rows);
  });
}

async function finalizeStalledRun(
  candidate: WatchdogCandidate,
  stallThresholdSeconds: number,
): Promise<void> {
  const runId = candidate.id;
  const run = await getRunSinkContext(runId);
  if (!run) return;
  // A run that was finalized between the SELECT and this point is
  // handled inside finalizeRun — the CAS on `sink_closed_at IS NULL`
  // makes this call a no-op. We don't gate here to keep the convergence
  // point identical to every other finalize path.

  const result = emptyRunResult();
  result.status = "failed";
  result.error = {
    message:
      candidate.reason === "boot-deadline"
        ? `Run never started executing — the runner posted no event within its ${candidate.bootBudgetSeconds}s provisioning budget. The runtime image pull, container boot, or sandbox provisioning did not finish in time.`
        : `Runner stopped reporting — no heartbeat for ${stallThresholdSeconds}s. The runner process may have crashed or lost network connectivity.`,
  };

  // Stop the workload and WAIT (bounded) for the stop to ack before
  // finalizing — a stalled runner is not necessarily dead (a remote microVM
  // that lost its event path keeps executing and billing with live
  // credentials). Awaiting the stop closes the credential-exposure window in
  // the common case; on a wedged daemon the helper times out and returns
  // false, and we force-finalize anyway (the finalize must never block
  // indefinitely on a wedged runtime).
  const stopped = await stopWorkloadAndWait(runId);
  if (!stopped) {
    logger.warn("run watchdog: stalled run's workload stop unacknowledged, force-finalizing", {
      runId,
    });
  }

  // A runner that stalled AFTER its agent emitted `output` still produced a
  // deliverable — durable in `run_logs`, but dropped by this path, which
  // builds its own `emptyRunResult()` instead of going through
  // `synthesiseFinalize`. Payload only: the terminal stays `failed`.
  //
  // Read AFTER the stop: a stalled runner is not necessarily a dead one (see
  // above), so a still-live workload can emit `output` during the stop window
  // — reading before it would miss exactly the payload this exists to save.
  // Same ordering as the cancel path (`abortRun` → `stopWorkloadAndWait` →
  // `synthesiseFinalize`, which reads inside).
  await applyRecoveredOutput(run, result);

  await finalizeRun({ run, result });
}
