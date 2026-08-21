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

import { and, eq, lt, lte, isNull, isNotNull, inArray, sql, desc, gte, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { storageDeletionJobs } from "@appstrate/db/schema";
import {
  deleteFile as storageDelete,
  downloadFile as storageDownload,
} from "@appstrate/db/storage";
import { recordStorageDeletionSweep, recordStorageDeletionResult } from "@appstrate/core/telemetry";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "@appstrate/env";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { listResponse } from "../lib/list-response.ts";
import type { ListEnvelope } from "@appstrate/shared-types";
import {
  RUN_WORKSPACE_BUCKET,
  parseRunWorkspaceManifestKey,
  parseRunDocumentsManifest,
  runWorkspaceDocumentKey,
} from "./run-workspace-manifest.ts";

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

/**
 * Backoff base and cap (retries never wait longer than 6h). `attempts` counts
 * CLAIMS, incremented by the claim itself (see {@link processStorageDeletionJobs}),
 * so a job claimed once and failed sits at `attempts = 1` and waits
 * `computeBackoffMs(1)` = `2^1 * 30s` ≈ 60s before its next claim.
 */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/**
 * Bounded claim size per worker pass. Deletes run in SERIES, so the batch size
 * and the lease are one budget: `batch × per-delete-worst-case` must stay under
 * {@link CLAIM_LEASE_MS}, otherwise the tail of a slow pass has its lease expire
 * mid-flight and another instance re-claims jobs this pass is still executing.
 * 50 × 15s ≈ 12.5 min, inside the 15-minute lease.
 */
const DEFAULT_BATCH_LIMIT = 50;

/**
 * Lease window: how far a claim pushes `next_attempt_at` forward while a pass
 * physically deletes the object. Pushing the timestamp forward IS the lease —
 * no separate column. A worker that crashes between claim and settle leaves its
 * jobs leased; they simply become due again once the lease expires and a later
 * pass re-runs the (idempotent) delete. Sized to cover a FULL batch of slow
 * deletes (see {@link DEFAULT_BATCH_LIMIT}) rather than a single one.
 */
const CLAIM_LEASE_MS = 15 * 60 * 1000;

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
 * A deadline expressed against the DATABASE clock (`now() + ms`).
 *
 * Every due/lease comparison the worker makes is evaluated by Postgres against
 * `now()`, so every deadline it WRITES has to come from the same clock. Writing
 * an app-clock `new Date(...)` instead makes the whole schedule shift by
 * whatever the API↔DB clock skew happens to be — a "retry now" stamped by an API
 * host running a few seconds ahead is simply not due yet, and the job silently
 * sits out the next passes.
 */
function dbClockDeadline(ms: number) {
  return sql`now() + make_interval(secs => ${ms / 1000})`;
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
interface ProcessStorageDeletionDeps {
  /** Physical delete (defaults to the real storage adapter). Idempotent on missing objects. */
  deleteFile?: (bucket: string, path: string) => Promise<void>;
  /** Small-object download used to expand run-workspace manifests. */
  downloadFile?: (bucket: string, path: string) => Promise<Uint8Array | null>;
  /** Max jobs to claim in this pass. */
  batchLimit?: number;
  /** Random source for backoff jitter (test seam). */
  rand?: () => number;
}

/** Outcome of one worker pass. */
interface ProcessStorageDeletionResult {
  claimed: number;
  completed: number;
  failed: number;
}

/**
 * Delete one outbox target. A run-workspace manifest is a durable deletion
 * index: delete every document it names first, then the manifest itself. If a
 * document delete fails, the manifest remains available and the whole job can
 * be retried idempotently. This lets parent-row cascades enqueue two bounded
 * jobs per run (bundle + manifest) without storage I/O inside their DB
 * transaction or silently orphaning `documents/*`.
 */
async function deleteStorageTarget(
  bucket: string,
  storageKey: string,
  del: (bucket: string, path: string) => Promise<void>,
  download: (bucket: string, path: string) => Promise<Uint8Array | null>,
): Promise<void> {
  const runId = bucket === RUN_WORKSPACE_BUCKET ? parseRunWorkspaceManifestKey(storageKey) : null;
  if (runId === null) {
    await del(bucket, storageKey);
    return;
  }

  const manifestBytes = await download(bucket, storageKey);
  if (manifestBytes) {
    // Strict shared parse (same reader the serve path uses): every entry name is
    // validated as a single path segment BEFORE it becomes a key, so a corrupted
    // manifest can never steer a delete outside the run's own prefix.
    const manifest = parseRunDocumentsManifest(manifestBytes, storageKey);
    for (const name of new Set(manifest.documents.map((d) => d.workspace_name))) {
      await del(bucket, runWorkspaceDocumentKey(runId, name));
    }
  }

  // Delete the index last. A retry can then always rediscover any document
  // whose previous physical deletion did not complete.
  await del(bucket, storageKey);
}

/**
 * One worker pass, using a claim → execute → settle lease (NO transaction held
 * across physical deletes — a slow/hanging storage backend must never pin a
 * connection idle-in-transaction, where `idle_in_transaction_session_timeout`
 * or a deploy would roll back completions that already physically succeeded):
 *
 *  1. **Claim** (single statement, autocommit): `UPDATE … SET next_attempt_at =
 *     now() + lease, attempts = attempts + 1 WHERE id IN (SELECT id … WHERE
 *     completed_at IS NULL AND next_attempt_at <= now() ORDER BY next_attempt_at
 *     LIMIT batch FOR UPDATE SKIP LOCKED) RETURNING …`. `SKIP LOCKED` in the
 *     inner select means concurrent passes never claim the same rows within the
 *     lease window; pushing `next_attempt_at` forward IS the lease (see
 *     {@link CLAIM_LEASE_MS}).
 *  2. **Execute** (no transaction): attempt each `deleteFile`.
 *  3. **Settle** (one autocommit UPDATE per job): success → `completed_at`;
 *     failure → `last_error` + backoff.
 *
 * `attempts` is incremented BY THE CLAIM, in SQL, and counts claims rather than
 * observed failures. A job whose execution KILLS the process (OOM on a
 * pathological manifest) never reaches a settle: incrementing at settle-time
 * only would leave it at `attempts = 0` forever while it re-crashes every worker
 * that re-claims it after the lease — invisible to the dead-letter list and its
 * metric, with only the backlog moving. Counting claims makes that job climb to
 * the threshold and surface.
 *
 * Both settles are guarded on `attempts = <the value this pass claimed with>`,
 * so a pass whose lease expired mid-flight (and whose job was re-claimed by
 * another instance, bumping `attempts`) can no longer overwrite the new owner's
 * counter or backoff with its own stale computation.
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
  const download = deps.downloadFile ?? storageDownload;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const rand = deps.rand ?? Math.random;

  let completed = 0;
  let failed = 0;

  // 1. Claim: lease a batch of due jobs in one statement. The inner
  //    FOR UPDATE SKIP LOCKED locks exactly the rows this pass takes; the outer
  //    UPDATE pushes their next_attempt_at out by the lease, counts the claim,
  //    and returns them.
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
    .set({
      nextAttemptAt: dbClockDeadline(CLAIM_LEASE_MS),
      attempts: sql`${storageDeletionJobs.attempts} + 1`,
    })
    .where(inArray(storageDeletionJobs.id, dueIds))
    .returning({
      id: storageDeletionJobs.id,
      bucket: storageDeletionJobs.bucket,
      storageKey: storageDeletionJobs.storageKey,
      // Post-increment value — the claim ordinal this pass owns.
      attempts: storageDeletionJobs.attempts,
    });

  // 2 + 3. Execute each delete OUTSIDE any transaction, then settle it with a
  //        single autocommit UPDATE, guarded on the claim this pass owns.
  for (const job of claimedJobs) {
    const owned = and(
      eq(storageDeletionJobs.id, job.id),
      eq(storageDeletionJobs.attempts, job.attempts),
      isNull(storageDeletionJobs.completedAt),
    );
    try {
      await deleteStorageTarget(job.bucket, job.storageKey, del, download);
      await db
        .update(storageDeletionJobs)
        .set({ completedAt: sql`now()`, lastError: null })
        .where(owned);
      completed += 1;
      recordStorageDeletionResult({ result: "completed" });
    } catch (err) {
      await db
        .update(storageDeletionJobs)
        .set({
          lastError: getErrorMessage(err),
          nextAttemptAt: dbClockDeadline(computeBackoffMs(job.attempts, rand)),
        })
        .where(owned);
      failed += 1;
      recordStorageDeletionResult({ result: "failed" });
      logger.warn("storage deletion job failed (will retry)", {
        jobId: job.id,
        bucket: job.bucket,
        storageKey: job.storageKey,
        attempts: job.attempts,
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

type StorageDeletionJobStatus = "pending" | "dead" | "completed";

/**
 * A storage-deletion job row as surfaced to the admin list.
 *
 * Wire casing per `docs/CASING_CONVENTIONS.md`: domain fields are snake_case;
 * only `id` and `createdAt` sit on the universal DB-convention carve-out list
 * (`completed_at`, like every other domain timestamp, does NOT).
 */
interface StorageDeletionJobView {
  id: string;
  bucket: string;
  storage_key: string;
  reason: string;
  attempts: number;
  next_attempt_at: string;
  completed_at: string | null;
  last_error: string | null;
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
 * paginated on the exact `(created_at, id)` sort tuple. `dead` = pending past
 * the attempt threshold (still retrying).
 *
 * Pagination is the codebase's Stripe-style cursor idiom (see
 * `docs/CASING_CONVENTIONS.md` → "Pagination styles"): `startingAfter` carries
 * the id of the last row of the previous page — the same contract as
 * `/api/end-users` and the document gallery — and the response is the standard
 * `{ object: "list", data, hasMore }` envelope. The cursor row is looked up to
 * recover its `created_at`, so the keyset comparison stays on the full sort
 * tuple.
 */
export async function listStorageDeletionJobs(params: {
  status: StorageDeletionJobStatus;
  limit: number;
  startingAfter?: string;
}): Promise<ListEnvelope<StorageDeletionJobView>> {
  const limit = Math.min(Math.max(params.limit, 1), 200);
  const conditions = [statusFilter(params.status)];

  if (params.startingAfter) {
    const [cursor] = await db
      .select({ createdAt: storageDeletionJobs.createdAt, id: storageDeletionJobs.id })
      .from(storageDeletionJobs)
      .where(eq(storageDeletionJobs.id, params.startingAfter))
      .limit(1);
    if (cursor) {
      conditions.push(
        or(
          lt(storageDeletionJobs.createdAt, cursor.createdAt),
          and(
            eq(storageDeletionJobs.createdAt, cursor.createdAt),
            lt(storageDeletionJobs.id, cursor.id),
          ),
        )!,
      );
    }
  }

  const rows = await db
    .select()
    .from(storageDeletionJobs)
    .where(and(...conditions))
    .orderBy(desc(storageDeletionJobs.createdAt), desc(storageDeletionJobs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data: StorageDeletionJobView[] = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    bucket: r.bucket,
    storage_key: r.storageKey,
    reason: r.reason,
    attempts: r.attempts,
    next_attempt_at: r.nextAttemptAt.toISOString(),
    completed_at: r.completedAt ? r.completedAt.toISOString() : null,
    last_error: r.lastError,
    createdAt: r.createdAt.toISOString(),
  }));
  return listResponse(data, { hasMore });
}

/**
 * Reset a pending job's `next_attempt_at` to now so the next worker pass retries
 * it immediately (operator "retry now"). Returns whether a row was reset.
 */
export async function retryStorageDeletionJob(id: string): Promise<boolean> {
  const reset = await db
    .update(storageDeletionJobs)
    .set({ nextAttemptAt: sql`now()` })
    .where(and(eq(storageDeletionJobs.id, id), isNull(storageDeletionJobs.completedAt)))
    .returning({ id: storageDeletionJobs.id });
  return reset.length > 0;
}

// ---------------------------------------------------------------------------
// Periodic worker lifecycle
// ---------------------------------------------------------------------------

let workerTimer: ReturnType<typeof setInterval> | null = null;
let passInFlight = false;

/**
 * Start the periodic storage-deletion worker: an immediate first pass (drains
 * any boot-time backlog) then a pass every `STORAGE_DELETION_WORKER_INTERVAL_MS`.
 * Safe to call multiple times.
 *
 * Passes are single-flight WITHIN a process: a pass that outlives the interval
 * (degraded storage backend) must not have the next tick start a second pass
 * against the same backlog. The claim's `SKIP LOCKED` lease would keep the two
 * passes on disjoint rows (they run on separate pool connections), so this is
 * not a correctness guard — it bounds concurrency: during a storage outage every
 * pass runs long, and letting each tick pile on another in-flight pass would
 * multiply the connections and the doomed delete calls against an already-sick
 * backend instead of simply falling behind.
 */
export function startStorageDeletionWorker(): void {
  if (workerTimer) return;
  const runPass = (): void => {
    if (passInFlight) {
      logger.warn("Storage deletion worker pass skipped — previous pass still running");
      return;
    }
    passInFlight = true;
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
      })
      .finally(() => {
        passInFlight = false;
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
