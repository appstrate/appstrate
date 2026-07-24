// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Transactional outbox for physical storage-object deletions.
 *
 * The invariant this table exists to protect: no S3/FS object may be silently
 * orphaned once its owning DB row disappears. Every place that deletes a row
 * whose bytes live in object storage INSERTs a job here **in the same
 * transaction** as the row delete (see `services/storage-deletion.ts`
 * `enqueueStorageDeletion`). Either both land or neither does — so a committed
 * delete always leaves a durable, replayable record of the object to purge.
 *
 * A background worker (`processStorageDeletionJobs`) claims due jobs
 * (`FOR UPDATE SKIP LOCKED`), calls `storage.deleteFile`, and either completes
 * the job or backs it off for a later retry. Deletion is **replayable
 * forever**: there is no max-attempts abandon. After a threshold a job merely
 * becomes visible as a dead letter (operator surface) while continuing to
 * retry at the capped backoff interval.
 *
 * Deliberately has NO foreign keys. A job must outlive the org / app / run /
 * document row it was created for — the whole point is to survive the cascade
 * that removed those rows.
 */
export const storageDeletionJobs = pgTable(
  "storage_deletion_jobs",
  {
    /** `sdj_` prefixed identifier (app-generated). */
    id: text("id").primaryKey(),
    /** Storage bucket (e.g. "documents", "uploads"). */
    bucket: text("bucket").notNull(),
    /** Object key WITHIN the bucket (no bucket prefix). */
    storageKey: text("storage_key").notNull(),
    /**
     * Why the object is being purged — one of `document_deleted`,
     * `org_deleted`, `application_deleted`, `end_user_deleted`,
     * `run_workspace_deleted`, `upload_expired`, `materialization_failed`.
     * Free text (audit/metric label), not a constrained enum.
     */
    reason: text("reason").notNull(),
    /** Delete attempts made so far. Drives the exponential backoff + dead-letter threshold. */
    attempts: integer("attempts").notNull().default(0),
    /** Earliest time the worker may next attempt this job. Bumped on each failure. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set once the object is confirmed gone (delete succeeded / object already absent). */
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Last failure message — operator diagnostics for dead letters. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Worker poll predicate: due, not-yet-completed jobs ordered by nextAttemptAt.
    // Partial so completed jobs (the long tail) never bloat the hot set the
    // worker scans.
    index("idx_storage_deletion_jobs_due")
      .on(table.nextAttemptAt)
      .where(sql`${table.completedAt} IS NULL`),
    // Dedup: at most one PENDING job per (bucket, key). A second enqueue for an
    // object already queued for deletion is a no-op (`ON CONFLICT DO NOTHING`),
    // so retried deletes / fast-path + cascade double-enqueues can't accumulate
    // unbounded duplicate pending rows. Scoped to pending only — once a job
    // completes it drops out of the index, so the SAME key can legitimately be
    // re-enqueued later (a fresh object reusing a recycled key).
    uniqueIndex("uq_storage_deletion_jobs_pending")
      .on(table.bucket, table.storageKey)
      .where(sql`${table.completedAt} IS NULL`),
  ],
);
