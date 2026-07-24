// SPDX-License-Identifier: Apache-2.0

/**
 * Transactional-outbox worker for physical storage-object deletion.
 *
 * The invariant: no S3/FS object may be silently orphaned once its owning DB
 * row is gone. Every row delete whose bytes live in object storage enqueues a
 * `storage_deletion_jobs` row IN THE SAME TRANSACTION (`enqueueStorageDeletion`)
 * — atomic with the delete, so a committed delete always leaves a durable,
 * replayable record of the object to purge. A background worker
 * (`processStorageDeletionJobs`) then claims due jobs, calls
 * `storage.deleteFile`, and either completes them or backs them off.
 *
 * Deletion is replayable forever: there is NO max-attempts abandon. Past a
 * threshold a job merely surfaces as a dead letter (operator surface +
 * metric) while continuing to retry at the capped backoff interval — an object
 * MUST eventually be purged, so a persistently-failing delete is a visibility
 * problem, never a reason to drop the job.
 */

import { and, eq, lt, lte, isNull, isNotNull, inArray, sql, desc, gte } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { storageDeletionJobs } from "@appstrate/db/schema";
import { deleteFile as storageDelete } from "@appstrate/db/storage";
import { recordStorageDeletionSweep, recordStorageDeletionResult } from "@appstrate/core/telemetry";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "@appstrate/env";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";

/** A Drizzle executor — either the root `db` or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One object to purge. `storageKey` is the IN-BUCKET path (no `bucket/` prefix). */
export interface StorageDeletionJobInput {
  bucket: string;
  storageKey: string;
  reason: string;
}

/**
 * Attempts past which a still-pending job is surfaced as a dead letter. It keeps
 * retrying at the capped backoff — the threshold is a visibility line, not an
 * abandon point.
 */
export const STORAGE_DELETION_DEAD_LETTER_THRESHOLD = 8;

/** Backoff base (first retry ≈ 30s) and cap (retries never wait longer than 6h). */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/** Bounded claim size per worker pass — keeps a single pass' lock set + I/O small. */
const DEFAULT_BATCH_LIMIT = 100;

/**
 * Lease window: how far a claim pushes `next_attempt_at` forward while a pass
 * physically deletes the object. Pushing the timestamp forward IS the lease —
 * no separate column. A worker that crashes between claim and settle leaves its
 * jobs leased; they simply become due again once the lease expires and a later
 * pass re-runs the (idempotent) delete. 5 minutes comfortably exceeds a healthy
 * delete's latency without parking a genuinely-stuck object for long.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Exponential backoff for the Nth attempt, capped and jittered. `min(2^attempts
 * * 30s, 6h)` plus up to 10% jitter so a burst of jobs failing together (e.g. a
 * storage outage) doesn't retry in a synchronized thundering herd. Pure +
 * exported for unit testing (jitter injected via `rand`).
 */
export function computeBackoffMs(attempts: number, rand: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts), BACKOFF_CAP_MS);
  return Math.floor(exp + rand() * exp * 0.1);
}

/**
 * Enqueue one or more storage-object deletions. INSERT them within the SAME
 * transaction as the row delete they accompany — that atomicity is the whole
 * point of the outbox. `onConflictDoNothing` de-dupes against the partial
 * unique `(bucket, storage_key) WHERE completed_at IS NULL`: re-enqueuing an
 * object already queued for deletion is a no-op, so retried deletes / fast-path
 * + cascade double-enqueues can't pile up duplicate pending rows.
 */
export async function enqueueStorageDeletion(
  tx: DbOrTx,
  input: StorageDeletionJobInput | StorageDeletionJobInput[],
): Promise<void> {
  const jobs = Array.isArray(input) ? input : [input];
  if (jobs.length === 0) return;
  await tx
    .insert(storageDeletionJobs)
    .values(
      jobs.map((j) => ({
        id: prefixedId("sdj"),
        bucket: j.bucket,
        storageKey: j.storageKey,
        reason: j.reason,
      })),
    )
    .onConflictDoNothing();
}

/** Injectable dependencies for {@link processStorageDeletionJobs} (DI, no module mocks). */
export interface ProcessStorageDeletionDeps {
  /** Physical delete (defaults to the real storage adapter). Idempotent on missing objects. */
  deleteFile?: (bucket: string, path: string) => Promise<void>;
  /** Max jobs to claim in this pass. */
  batchLimit?: number;
  /** Random source for backoff jitter (test seam). */
  rand?: () => number;
}

/** Outcome of one worker pass. */
export interface ProcessStorageDeletionResult {
  claimed: number;
  completed: number;
  failed: number;
}

/**
 * One worker pass, using a claim → execute → settle lease (NO transaction held
 * across physical deletes — a slow/hanging storage backend must never pin a
 * connection idle-in-transaction, where `idle_in_transaction_session_timeout`
 * or a deploy would roll back completions that already physically succeeded):
 *
 *  1. **Claim** (single statement, autocommit): `UPDATE … SET next_attempt_at =
 *     now() + lease WHERE id IN (SELECT id … WHERE completed_at IS NULL AND
 *     next_attempt_at <= now() ORDER BY next_attempt_at LIMIT batch FOR UPDATE
 *     SKIP LOCKED) RETURNING …`. `SKIP LOCKED` in the inner select means
 *     concurrent passes never claim the same rows within the lease window;
 *     pushing `next_attempt_at` forward IS the lease (see {@link CLAIM_LEASE_MS}).
 *  2. **Execute** (no transaction): attempt each `deleteFile`.
 *  3. **Settle** (one autocommit UPDATE per job): success → `completed_at`;
 *     failure → `attempts + 1` + `last_error` + backoff (guarded on
 *     `completed_at IS NULL`).
 *
 * `storage.deleteFile` is idempotent on a missing object (FS tolerates ENOENT;
 * S3 DeleteObject returns success for an absent key), so a crash between (2) and
 * (3) — or a re-run after the lease expires — simply deletes an already-gone
 * object cleanly.
 */
export async function processStorageDeletionJobs(
  deps: ProcessStorageDeletionDeps = {},
): Promise<ProcessStorageDeletionResult> {
  const del = deps.deleteFile ?? storageDelete;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const rand = deps.rand ?? Math.random;

  let completed = 0;
  let failed = 0;

  // 1. Claim: lease a batch of due jobs in one statement. The inner
  //    FOR UPDATE SKIP LOCKED locks exactly the rows this pass takes; the outer
  //    UPDATE pushes their next_attempt_at out by the lease and returns them.
  const dueIds = db
    .select({ id: storageDeletionJobs.id })
    .from(storageDeletionJobs)
    .where(
      and(
        isNull(storageDeletionJobs.completedAt),
        lte(storageDeletionJobs.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(storageDeletionJobs.nextAttemptAt)
    .limit(batchLimit)
    .for("update", { skipLocked: true });

  const claimedJobs = await db
    .update(storageDeletionJobs)
    .set({ nextAttemptAt: new Date(Date.now() + CLAIM_LEASE_MS) })
    .where(inArray(storageDeletionJobs.id, dueIds))
    .returning({
      id: storageDeletionJobs.id,
      bucket: storageDeletionJobs.bucket,
      storageKey: storageDeletionJobs.storageKey,
      attempts: storageDeletionJobs.attempts,
    });

  // 2 + 3. Execute each delete OUTSIDE any transaction, then settle it with a
  //        single autocommit UPDATE.
  for (const job of claimedJobs) {
    try {
      await del(job.bucket, job.storageKey);
      await db
        .update(storageDeletionJobs)
        .set({ completedAt: new Date(), lastError: null })
        .where(eq(storageDeletionJobs.id, job.id));
      completed += 1;
      recordStorageDeletionResult({ result: "completed" });
    } catch (err) {
      const attempts = job.attempts + 1;
      await db
        .update(storageDeletionJobs)
        .set({
          attempts,
          lastError: getErrorMessage(err),
          nextAttemptAt: new Date(Date.now() + computeBackoffMs(attempts, rand)),
        })
        .where(and(eq(storageDeletionJobs.id, job.id), isNull(storageDeletionJobs.completedAt)));
      failed += 1;
      recordStorageDeletionResult({ result: "failed" });
      logger.warn("storage deletion job failed (will retry)", {
        jobId: job.id,
        bucket: job.bucket,
        storageKey: job.storageKey,
        attempts,
        error: getErrorMessage(err),
      });
    }
  }

  await emitBacklogMetrics();
  return { claimed: claimedJobs.length, completed, failed };
}

/** Cheap COUNT/MIN over the pending set → the outbox backlog gauges. */
async function emitBacklogMetrics(): Promise<void> {
  try {
    const [stats] = await db
      .select({
        backlog: sql<number>`COUNT(*)::int`,
        oldestCreatedAt: sql<Date | null>`MIN(${storageDeletionJobs.createdAt})`,
        deadLetters: sql<number>`COUNT(*) FILTER (WHERE ${storageDeletionJobs.attempts} >= ${STORAGE_DELETION_DEAD_LETTER_THRESHOLD})::int`,
      })
      .from(storageDeletionJobs)
      .where(isNull(storageDeletionJobs.completedAt));
    const backlog = Number(stats?.backlog ?? 0);
    const deadLetters = Number(stats?.deadLetters ?? 0);
    const oldest = stats?.oldestCreatedAt ? new Date(stats.oldestCreatedAt).getTime() : 0;
    const oldestPendingAgeSeconds = oldest ? Math.max(0, (Date.now() - oldest) / 1000) : 0;
    recordStorageDeletionSweep({ backlog, oldestPendingAgeSeconds, deadLetters });
  } catch (err) {
    // Metrics are best-effort — a failed COUNT must never break the worker pass.
    logger.warn("storage deletion backlog metrics failed", { error: getErrorMessage(err) });
  }
}

// ---------------------------------------------------------------------------
// Operator surface (admin dead-letter visibility)
// ---------------------------------------------------------------------------

export type StorageDeletionJobStatus = "pending" | "dead" | "completed";

/** A storage-deletion job row as surfaced to the admin list. */
export interface StorageDeletionJobView {
  id: string;
  bucket: string;
  storageKey: string;
  reason: string;
  attempts: number;
  nextAttemptAt: string;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function statusFilter(status: StorageDeletionJobStatus) {
  switch (status) {
    case "completed":
      return isNotNull(storageDeletionJobs.completedAt);
    case "dead":
      return and(
        isNull(storageDeletionJobs.completedAt),
        gte(storageDeletionJobs.attempts, STORAGE_DELETION_DEAD_LETTER_THRESHOLD),
      );
    case "pending":
    default:
      return isNull(storageDeletionJobs.completedAt);
  }
}

/**
 * List storage-deletion jobs for the operator surface, newest-first, keyset-
 * paginated on `created_at` (cursor = the last row's `created_at` ISO string).
 * `dead` = pending past the attempt threshold (still retrying).
 */
export async function listStorageDeletionJobs(params: {
  status: StorageDeletionJobStatus;
  limit: number;
  cursor?: string;
}): Promise<{ items: StorageDeletionJobView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit, 1), 200);
  const cursorDate = params.cursor ? new Date(params.cursor) : null;
  const rows = await db
    .select()
    .from(storageDeletionJobs)
    .where(
      cursorDate && !Number.isNaN(cursorDate.getTime())
        ? and(statusFilter(params.status), lt(storageDeletionJobs.createdAt, cursorDate))
        : statusFilter(params.status),
    )
    .orderBy(desc(storageDeletionJobs.createdAt), desc(storageDeletionJobs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: StorageDeletionJobView[] = page.map((r) => ({
    id: r.id,
    bucket: r.bucket,
    storageKey: r.storageKey,
    reason: r.reason,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
  }));
  const nextCursor = hasMore ? page.at(-1)!.createdAt.toISOString() : null;
  return { items, nextCursor };
}

/**
 * Reset a pending job's `next_attempt_at` to now so the next worker pass retries
 * it immediately (operator "retry now"). No-op on a completed / unknown job.
 * Returns whether a pending row was reset.
 */
export async function retryStorageDeletionJob(id: string): Promise<boolean> {
  const reset = await db
    .update(storageDeletionJobs)
    .set({ nextAttemptAt: new Date() })
    .where(and(eq(storageDeletionJobs.id, id), isNull(storageDeletionJobs.completedAt)))
    .returning({ id: storageDeletionJobs.id });
  return reset.length > 0;
}

// ---------------------------------------------------------------------------
// Periodic worker lifecycle
// ---------------------------------------------------------------------------

let workerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic storage-deletion worker: an immediate first pass (drains
 * any boot-time backlog) then a pass every `STORAGE_DELETION_WORKER_INTERVAL_MS`.
 * Safe to call multiple times.
 */
export function startStorageDeletionWorker(): void {
  if (workerTimer) return;
  const runPass = (): void => {
    processStorageDeletionJobs()
      .then((r) => {
        if (r.completed > 0 || r.failed > 0)
          logger.info("Storage deletion worker pass", {
            claimed: r.claimed,
            completed: r.completed,
            failed: r.failed,
          });
      })
      .catch((err) => {
        logger.warn("Storage deletion worker pass failed", { error: getErrorMessage(err) });
      });
  };
  runPass();
  workerTimer = setInterval(runPass, getEnv().STORAGE_DELETION_WORKER_INTERVAL_MS);
  workerTimer.unref?.();
}

/** Stop the periodic worker. Called from the shutdown handler. */
export function stopStorageDeletionWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}
