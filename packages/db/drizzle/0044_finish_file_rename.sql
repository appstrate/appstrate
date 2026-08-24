-- Finish the `document` → `file` rename at the PHYSICAL layer (issue #1177,
-- phase 3), and drop two columns nothing reads.
--
-- 0043 renamed the tables, the enum type, the columns, the constraints and the
-- indexes. It deliberately stopped short of four things whose only argument for
-- staying was that they were already written into live rows and live objects:
-- the `doc_` row-id prefix, the `documents` bucket + `documents/` key prefix,
-- the `document_*` deletion reasons, and the `DOCUMENT_*` environment
-- variables. That argument is spent — there is no production data behind it —
-- so this migration is the storage half of finishing the job, and the code half
-- lands in the same commit.
--
-- ═══ WHAT THIS DOES NOT DO, AND WHY IT MATTERS ═══
--
-- IT MOVES NO BYTES. Object storage is not reachable from SQL. After this runs
-- the `files` rows say `files/<app>/<id>/<name>` while the objects are still
-- physically at `documents/<app>/<id>/<name>`, and every run-workspace input
-- object is still at `{runId}/documents/<name>`. A download then 404s on a file
-- that exists. Deploying this REQUIRES an out-of-band object move, done in the
-- same window:
--
--   * S3/MinIO — copy the `documents` bucket to a `files` bucket, then delete
--     the old one (`aws s3 sync s3://documents s3://files`, or `mc mirror`);
--   * filesystem storage (tier ≤ 2) — `mv ./data/storage/documents
--     ./data/storage/files`;
--   * run-workspace bucket — rewrite the second key segment of every
--     `{runId}/documents/<name>` object to `{runId}/files/<name>`. In-flight
--     runs cannot survive that rename; drain them first.
--
-- IT DOES NOT RE-MINT `files.id`. New rows are minted `file_` by
-- `prefixedId("file")`, and `FILE_ID_RE` (`@appstrate/core/file-uri`) now
-- accepts only that shape. Rows carrying a `doc_` id therefore become
-- unaddressable: the id fails validation before any SELECT. Re-minting them is
-- not a five-table UPDATE — the id is quoted inside `runs.input`,
-- `runs.result`, `run_logs`, chat message payloads and `audit_events.after`, so
-- a rewrite that stops at `files.id` + `file_links.file_id` would leave every
-- rerun pointing at an id that no longer exists. A half-rewrite is worse than
-- none, so this migration does neither: a development database holding `doc_`
-- rows is reset, not migrated.
--
-- ═══ WATERMARK COST OF THE 0044/0045 DELETION ═══
--
-- Two migrations were deleted from this folder in the same change:
-- `0044_documents_scope_strings` and `0045_documents_scope_delimited_strings`.
-- Both rewrote persisted `documents:*` permission scopes into `files:*`, and
-- both existed to complement a read-time canonicalization
-- (`canonicalPermissions()`) that has since been deleted from the codebase.
-- Their own headers state the platform works WITHOUT them.
--
-- The cost, written down rather than discovered: a database that already
-- applied them carries a `drizzle.__drizzle_migrations` watermark of
-- 1787480000000, which now matches no journal entry. Drizzle compares
-- timestamps, not tags, so nothing errors — but the bookkeeping table records
-- two migrations this folder can no longer explain. This file's `when`
-- (1787562217863) is above that watermark, so it still runs on such a database.
-- The scope rewrites those two performed are forward-only data changes that
-- cannot be un-run and do not need to be: the scope strings they produced
-- (`files:*`) are exactly what current code reads.
--
-- ═══ IDEMPOTENCY ═══
--
-- Every statement's WHERE clause is the exact condition it removes, so a re-run
-- touches zero rows and a partially-applied environment converges — the same
-- shape 0042/0043 use, and the reason 0040 was made convergent earlier on this
-- branch. The column drops are `IF EXISTS`.

-- Step 1: `files.storage_key`. Written as `{bucket}/{path}` and split back
-- apart by `parseStorageKey`, so the stored prefix and `FILES_BUCKET` must
-- agree or every download resolves against a bucket that holds nothing.
-- Anchored at the START of the value: `documents` is the bucket segment, and an
-- application id or a filename containing the word must not be touched.
UPDATE "files"
SET "storage_key" = 'files/' || substring("storage_key" FROM 11)
WHERE "storage_key" LIKE 'documents/%';--> statement-breakpoint

-- Step 2: the outbox's copy of the bucket name. `storage_deletion_jobs` rows
-- are a durable work queue — a pending job enqueued before this deploy names
-- the bucket it was enqueued against, and the worker would delete from a bucket
-- that (after the operator's object move) no longer exists.
UPDATE "storage_deletion_jobs"
SET "bucket" = 'files'
WHERE "bucket" = 'documents';--> statement-breakpoint

-- Step 3: run-workspace input keys held by the outbox. `deleteRunFiles`
-- (`services/run-workspace-storage.ts`) enqueues one job per input object under
-- `{runId}/documents/<name>` on the launch-rollback path; every other
-- run-workspace job stores the bundle or the manifest key, which do not carry
-- the segment. Anchored on the SECOND segment via a regex so a runId or a
-- filename spelled `documents` cannot be rewritten.
UPDATE "storage_deletion_jobs"
SET "storage_key" = regexp_replace("storage_key", '^([^/]+)/documents/', '\1/files/')
WHERE "bucket" = 'run-workspace'
  AND "storage_key" ~ '^[^/]+/documents/';--> statement-breakpoint

-- Step 4: the two deletion reasons. Free-text audit/metric labels, so the only
-- cost of leaving them would be an operator's `GROUP BY reason` split across two
-- spellings of one event. Exact equality, never a substring rewrite.
UPDATE "storage_deletion_jobs"
SET "reason" = 'file_deleted'
WHERE "reason" = 'document_deleted';--> statement-breakpoint

UPDATE "storage_deletion_jobs"
SET "reason" = 'file_expired'
WHERE "reason" = 'document_expired';--> statement-breakpoint

-- Step 5: two columns annotated WRITTEN, NEVER READ, both kept on the premise
-- that they held real production data.
--
--   * `model_provider_credentials.last_refresh_failure_at` — written beside
--     `refresh_failure_count` on every transient refresh failure. The COUNTER
--     drives the reconnect escalation; the timestamp was never in that
--     predicate, exposed in no DTO, and read only by the integration tests
--     asserting its own write.
--   * `model_provider_pairings.consumed_from_ip` — written by `consumePairing`
--     and read by nothing. Its "for audit" justification never held:
--     `cleanupExpiredPairings` DELETEs the row an hour past expiry, and the
--     audit entry written at redeem time omits the IP, so the trail it was
--     meant to leave was erased and the record that survives never carried it.
--
-- FORWARD-ONLY. Neither column was an input to any decision, so nothing
-- downstream needs the dropped values. Guarded so a partially-migrated
-- environment converges.
ALTER TABLE "model_provider_credentials" DROP COLUMN IF EXISTS "last_refresh_failure_at";--> statement-breakpoint
ALTER TABLE "model_provider_pairings" DROP COLUMN IF EXISTS "consumed_from_ip";
