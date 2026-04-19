// SPDX-License-Identifier: Apache-2.0

/**
 * Inline-run compaction worker.
 *
 * Daily BullMQ job that NULLs the manifest+prompt of shadow packages older
 * than `INLINE_RUN_LIMITS.retention_days` and deletes their run_logs.
 * Preserves `runs` metadata (id, status, cost, duration, tokens) for
 * accounting. Cascade delete is NEVER used — a hard DELETE on a shadow
 * package would cascade to `runs` via FK.
 *
 * See docs/specs/INLINE_RUNS.md §8.
 */

import { and, eq, lt, notInArray, sql, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, runs, runLogs } from "@appstrate/db/schema";
import { createQueue } from "../infra/queue/index.ts";
import type { JobQueue } from "../infra/queue/index.ts";
import { logger } from "../lib/logger.ts";
import { getInlineRunLimits } from "./run-limits.ts";

// ---------------------------------------------------------------------------
// Core compaction — shared by worker, tests, and admin tools
// ---------------------------------------------------------------------------

export interface CompactionResult {
  compactedPackages: number;
  deletedRunLogs: number;
}

/**
 * Compact shadow packages older than `retentionDays`. Safe to call outside
 * a BullMQ job context (tests invoke it directly). Idempotent — repeatedly
 * NULLing already-NULLed manifests is cheap and does not re-wake rows.
 */
export async function compactInlineRuns(retentionDays: number): Promise<CompactionResult> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

  // 1. Find candidate shadow ids (needed BEFORE the UPDATE so we can scope
  //    the log-deletion join; also lets tests assert on which rows moved).
  //
  //    Exclude shadows that still have an active run — compacting under a
  //    running job would truncate its logs mid-flight. Operators who lower
  //    retention_days near the timeout ceiling (or hung jobs that outlive it)
  //    would otherwise lose in-progress logs. Active shadows are picked up
  //    on the next daily pass once their runs terminate.
  const candidates = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(
        eq(packages.ephemeral, true),
        lt(packages.createdAt, cutoff),
        // Filter out already-compacted rows. draft_manifest becomes '{}'
        // after compaction — retest with jsonb equality.
        sql`${packages.draftManifest} <> '{}'::jsonb`,
        // No active run referencing this shadow.
        sql`NOT EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.packageId} = ${packages.id}
            AND ${runs.status} IN ('pending', 'running')
        )`,
      ),
    );

  if (candidates.length === 0) return { compactedPackages: 0, deletedRunLogs: 0 };

  const candidateIds = candidates.map((c) => c.id);

  // 2. NULL the manifest + prompt on the shadow rows.
  await db
    .update(packages)
    .set({
      draftManifest: {},
      draftContent: "",
      updatedAt: new Date(),
    })
    .where(inArray(packages.id, candidateIds));

  // 3. Delete run_logs for their terminal runs. Keep the `runs` rows intact.
  //    Belt-and-braces: the candidate query already rejects shadows with
  //    active runs, but filtering again here ensures a run that just flipped
  //    to running between the two selects still keeps its logs.
  const affectedRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(inArray(runs.packageId, candidateIds), notInArray(runs.status, ["pending", "running"])),
    );

  let deletedRunLogs = 0;
  if (affectedRuns.length > 0) {
    const runIds = affectedRuns.map((r) => r.id);
    const deleted = await db
      .delete(runLogs)
      .where(inArray(runLogs.runId, runIds))
      .returning({ id: runLogs.id });
    deletedRunLogs = deleted.length;
  }

  logger.info("Inline compaction finished", {
    compactedPackages: candidateIds.length,
    deletedRunLogs,
    retentionDays,
  });

  return { compactedPackages: candidateIds.length, deletedRunLogs };
}

// ---------------------------------------------------------------------------
// BullMQ worker
// ---------------------------------------------------------------------------

const QUEUE_NAME = "inline-compaction";
const JOB_NAME = "compact-shadows";
const SCHEDULER_ID = "inline-compaction-daily";
const DAILY_CRON = "0 3 * * *"; // 03:00 UTC daily — off-peak.

interface CompactionJobData {
  retentionDays: number;
}

let compactionQueue: JobQueue<CompactionJobData> | null = null;

async function getQueue(): Promise<JobQueue<CompactionJobData>> {
  if (!compactionQueue) {
    compactionQueue = await createQueue<CompactionJobData>(QUEUE_NAME);
  }
  return compactionQueue;
}

/** Start the worker + register the daily repeatable scheduler. */
export async function initInlineCompactionWorker(): Promise<void> {
  const queue = await getQueue();

  queue.process(
    async (job) => {
      const retentionDays = job.data.retentionDays ?? getInlineRunLimits().retention_days;
      await compactInlineRuns(retentionDays);
    },
    { concurrency: 1 },
  );

  const limits = getInlineRunLimits();
  await queue.upsertScheduler(
    SCHEDULER_ID,
    { pattern: DAILY_CRON, tz: "UTC" },
    { name: JOB_NAME, data: { retentionDays: limits.retention_days } },
  );

  logger.info("Inline compaction worker started", {
    retentionDays: limits.retention_days,
    cron: DAILY_CRON,
  });
}

/** Graceful shutdown — part of the boot.ts shutdown ordering. */
export async function shutdownInlineCompactionWorker(): Promise<void> {
  await compactionQueue?.shutdown();
  compactionQueue = null;
}
