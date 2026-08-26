-- 0001 — rename every `doc_` file id to `file_`, and every reference to one.
--
-- APPLIED TO PRODUCTION 2026-08-26. Not replayed; kept as the record.
--
-- Why this is here and not in packages/db/drizzle/: it rewrites row CONTENTS,
-- not schema. See docs/NO_TRANSITIONAL_CODE.md §2 — and 0046's header, which
-- exists only because the data half of this same rename (#1177) was put into
-- drizzle migrations and then deleted.
--
-- The bug it fixed: `FILE_ID_RE` (@appstrate/core/file-uri) accepts only
-- `file_`, and loadFileForPreview / resolveFileForActor
-- (apps/api/src/services/files.ts:1220,1285) test it BEFORE any SELECT — so a
-- `doc_` id was a 404 that never reached the database. 0043 renamed the table
-- and 0044 rewrote storage_key; neither touched files.id. On v1.0.0-beta.53
-- every stored file 404'd on preview and download at once.
--
-- The validator was deliberately left strict. The data moved instead.
--
-- Rehearsed against a pg_dump of live production restored into a throwaway
-- postgres:16-alpine, then applied. Both runs, identical:
--
--   files.id                UPDATE 521
--   file_links.file_id      UPDATE 25    (2 FKs dropped + recreated verbatim;
--                                         neither carries ON UPDATE, so the
--                                         parent id cannot move under them)
--   runs.input              UPDATE 64    document://doc_x -> appfile://file_x
--   chat_messages.content   UPDATE 59    doc_x -> file_x, ANYWHERE in the JSON
--
-- Writes 3 and 4 match `doc_` + a STRICT UUID, so the 11 chat rows that merely
-- DISCUSS the format in prose (`"docId": "doc_123"`, a truncated
-- `document://doc_...`) are untouched.
--
-- ═══ WHERE WRITE 4 FELL SHORT — READ THIS BEFORE COPYING IT ═══
--
-- Write 3 rewrites the whole URI, scheme included. Write 4 has NO
-- `document://` arm: it substitutes the id wherever it appears, so a chat
-- payload holding `document://doc_<uuid>` became `document://file_<uuid>` —
-- the retired scheme carrying the CURRENT id. Neither the form that was there
-- before nor the one `runs.input` was moved to. Measured on production
-- afterwards: 59 rows, 127 distinct references, 118 of them naming a row that
-- exists in `files`.
--
-- Nothing that worked broke. `document://` was retired in #1177 and
-- `parseFileUri` refuses it, so those references were already unresolvable
-- before this script ran; it moved them from one dead form to another. They
-- are one `document://` -> `appfile://` rewrite away from resolving, and that
-- rewrite is a product decision (it would make historical chat attachments
-- start resolving), not a repair this script should have made silently.
--
-- The lesson is in the verify query below, not in the SQL: the shipped check
-- (`content::text ~ 'doc_[0-9a-f]{8}-'`) returns 0 for the intended outcome AND
-- for this one, so it reported success either way. A verification that cannot
-- distinguish the two results it is meant to choose between is not one.
--
-- NOT touched, deliberately:
--   * files.storage_key keeps its `doc_` path segment — nothing derives it from
--     the id and nothing parses the id back out (parseStorageKey returns the
--     bucket only). No storage object moved.
--   * run_logs keeps its `document://doc_…` prose — immutable emitted text.
--
-- Verify before:
--   SELECT (SELECT count(*) FROM files WHERE id LIKE 'doc\_%'),
--          (SELECT count(*) FROM file_links WHERE file_id LIKE 'doc\_%'),
--          (SELECT count(*) FROM runs WHERE input::text ~ 'document://doc_'),
--          (SELECT count(*) FROM chat_messages WHERE content::text ~ 'doc_[0-9a-f]{8}-');
-- Verify after: all four zero — necessary, NOT sufficient for write 4. Add the
-- query that separates the two outcomes it cannot:
--   SELECT count(*) FROM chat_messages WHERE content::text ~ 'document://file_';
--   -- 0 = the id AND the scheme moved; >0 = only the id did (what happened here)
-- plus
--   SELECT count(*) FROM file_links l
--   WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.id = l.file_id);  -- 0
--   SELECT count(*) FROM pg_constraint
--   WHERE confrelid = 'public.files'::regclass AND contype = 'f';     -- 2
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';
ALTER TABLE "file_links" DROP CONSTRAINT IF EXISTS "file_links_file_id_files_id_fk";
ALTER TABLE "file_links" DROP CONSTRAINT IF EXISTS "file_links_file_id_org_id_fk";
UPDATE "files" SET "id" = 'file_' || substring("id" FROM 5) WHERE "id" LIKE 'doc\_%';
UPDATE "file_links" SET "file_id" = 'file_' || substring("file_id" FROM 5) WHERE "file_id" LIKE 'doc\_%';
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
END $$;
UPDATE "runs"
SET "input" = regexp_replace(
      "input"::text,
      'document://doc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
      'appfile://file_\1', 'g')::jsonb
WHERE "input"::text ~ 'document://doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
UPDATE "chat_messages"
SET "content" = regexp_replace(
      "content"::text,
      'doc_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
      'file_\1', 'g')::jsonb
WHERE "content"::text ~ 'doc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
-- No-ops, kept because this file records what actually ran: `SET LOCAL` is
-- already scoped to the transaction and reverts at the `COMMIT` below, so
-- restoring the two timeouts by hand changes nothing either way.
SET LOCAL lock_timeout = DEFAULT;
SET LOCAL statement_timeout = DEFAULT;

COMMIT;
