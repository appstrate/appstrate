-- Rename every `doc_` row id to `file_`, and every reference to one.
--
-- ═══ WHY THIS EXISTS ═══
--
-- `FILE_ID_RE` (`@appstrate/core/file-uri`) accepts only `file_`, and
-- `loadFileForPreview` / `resolveFileForActor`
-- (`apps/api/src/services/files.ts:1220,1285`) test it BEFORE any SELECT and
-- return null on a miss. A `doc_` id is therefore a 404 that never reaches the
-- database. On v1.0.0-beta.53 that took out EVERY stored file on production at
-- once: preview and download, all 521 of them.
--
-- The prose in `file-uri.ts` asserted the row id prefix "was `doc_` until the
-- rename was finished at the physical layer". It never was. 0043 renamed the
-- TABLE (`ALTER TABLE documents RENAME TO files`), 0044 rewrote `storage_key`
-- — neither touches `files.id`, and no migration between 0000 and 0052 does.
-- The rename was finished everywhere except the one place a validator reads.
--
-- Widening the validator to accept `doc_` was considered and REJECTED: it makes
-- a retired spelling permanently legal in a design whose whole point is that one
-- spelling is written and the same one is read. The data moves instead.
--
-- ═══ WHAT IS NOT TOUCHED, AND WHY ═══
--
-- `files.storage_key` keeps its `doc_` path segment. Nothing derives it from
-- the id and nothing parses the id back out of it: `parseStorageKey`
-- (`services/files.ts:116`) splits `{bucket}/{path}` and returns the bucket
-- only; the path is written once at creation by `fileStoragePath(...)` and
-- afterwards only ever read back from the row. Rewriting it would mean MOVING
-- 521 storage objects a second time in one day — real risk, for a string no
-- reader interprets. The key is an opaque pointer; it stays.
--
-- `run_logs` keeps its `document://doc_…` prose. Those rows are the immutable
-- text a run actually emitted, displayed as history. Nothing resolves a URI out
-- of log prose, so rewriting them would only make the record disagree with what
-- was printed.
--
-- ═══ THE FOUR WRITES ═══
--
-- 1. `files.id` — 521 rows, every one matching `doc_` + a strict UUID
--    (verified: 521/521). The `substring(... FROM 5)` is safe because the
--    `LIKE 'doc\_%'` guard is exactly the condition that makes offset 5 the
--    character after `doc_`.
--
-- 2. `file_links.file_id` — 25 rows. Two FKs reference `files`, both CASCADE
--    on delete but neither ON UPDATE, so the parent id cannot move while a
--    child points at it. They are dropped and recreated verbatim around the
--    update; `uq_files_id_org_id` (the unique index the composite FK requires)
--    is untouched and still there to bind to.
--
-- 3. `runs.input` — 82 rows carrying `document://doc_…`. Rewritten to
--    `appfile://file_…`, which renames the id AND retires the scheme in one
--    pass. These references were written when `document://` was still read
--    (pre-#1177); porting the spelling preserves what the row MEANT rather
--    than freezing a form nothing can resolve.
--
-- 4. `chat_messages` — 60 rows carrying bare `doc_…` ids inside persisted
--    payloads (`primary_document_id`, `documents[].id`). A plain id rename.
--
-- Writes 3 and 4 match `doc_` followed by a STRICT UUID, never a bare prefix,
-- so a word like `doc_something` in user prose cannot be caught.
--
-- ═══ IDEMPOTENCE AND RE-RUN ═══
--
-- Every statement's WHERE clause is exactly the condition it removes, so a
-- second application matches zero rows. The drops are `IF EXISTS` and the
-- re-adds are guarded, so a partially-applied environment converges.
--
-- ═══ LOCK AND COST ═══
--
-- Fenced with `lock_timeout` (acquisition) and `statement_timeout` (execution),
-- same instrument as 0047-0052. `files` is 521 rows and `file_links` 25; the
-- two jsonb rewrites touch 142 rows between them. Rehearsed against a restored
-- copy of production: see the PR body for the measured numbers.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '300s';--> statement-breakpoint
ALTER TABLE "file_links" DROP CONSTRAINT IF EXISTS "file_links_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "file_links" DROP CONSTRAINT IF EXISTS "file_links_file_id_org_id_fk";--> statement-breakpoint
UPDATE "files" SET "id" = 'file_' || substring("id" FROM 5) WHERE "id" LIKE 'doc\_%';--> statement-breakpoint
UPDATE "file_links" SET "file_id" = 'file_' || substring("file_id" FROM 5) WHERE "file_id" LIKE 'doc\_%';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'file_links_file_id_files_id_fk' AND conrelid = 'public.file_links'::regclass
  ) THEN
    ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_files_id_fk"
      FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'file_links_file_id_org_id_fk' AND conrelid = 'public.file_links'::regclass
  ) THEN
    ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_org_id_fk"
      FOREIGN KEY ("file_id", "org_id") REFERENCES "files"("id", "org_id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint
UPDATE "runs"
SET "input" = regexp_replace(
      "input"::text,
      'document://doc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
      'appfile://file_\1', 'g')::jsonb
WHERE "input"::text ~ 'document://doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';--> statement-breakpoint
UPDATE "chat_messages"
SET "content" = regexp_replace(
      "content"::text,
      'doc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
      'file_\1', 'g')::jsonb
WHERE "content"::text ~ 'doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
