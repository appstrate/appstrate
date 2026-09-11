-- 0002 — finish what 0001's write 4 left half-done in `chat_messages`.
--
-- Why this exists: `0001` rewrote the file id everywhere it appeared, including
-- INSIDE a URI, so a chat payload holding `document://doc_<uuid>` became
-- `document://file_<uuid>` — the retired scheme carrying the current id.
-- `runs.input` got the full treatment (`document://doc_x` -> `appfile://file_x`)
-- because its statement matched the whole URI; `chat_messages` did not, because
-- its statement matched the id alone. See 0001's header.
--
-- What this changes, and why it is a decision rather than a repair: those rows
-- have been unresolvable since #1177 retired the `document://` scheme —
-- `parseFileUri` refuses it, so nobody has seen them work. Rewriting the scheme
-- makes historical chat attachments start resolving. That is the intent the
-- rows recorded (a user attached those files) and it is what the sibling table
-- already got, but it is a visible change to displayed history, not a silent
-- correction. Applied deliberately, not folded into 0001.
--
-- Scope, measured on production before writing this:
--   chat_messages with `document://file_`   59 rows
--   distinct references                     127
--   of which name a row in `files`          118
--   chat_messages with `appfile://file_`      0 rows
--
-- The 9 references naming no row are files deleted since the message was
-- written; the rewrite leaves them pointing at a missing id, which is what an
-- attachment to a deleted file should look like — the alternative is inventing
-- a tombstone this migration has no business creating.
--
-- NOT touched: the 7 rows carrying `document://doc_` in PROSE (a truncated
-- `document://doc_...` quoted inside conversation text). The strict-UUID
-- pattern skips them, exactly as in 0001, so a message that DISCUSSES the
-- format is not rewritten as though it referenced a file.
--
-- Idempotent: the WHERE clause is exactly the condition the UPDATE removes, so
-- a second run matches zero rows.
--
-- ═══ VERIFY — the query must DISCRIMINATE ═══
--
-- 0001 shipped a check that returned 0 for the intended outcome AND for the
-- wrong one, which is why it reported success. Both halves are required here:
--
--   -- Before: 59 and 0. After: 0 and 59.
--   SELECT (SELECT count(*) FROM chat_messages WHERE content::text ~ 'document://file_'),
--          (SELECT count(*) FROM chat_messages WHERE content::text ~ 'appfile://file_');
--
--   -- Must be 7 before AND after — the prose rows are untouched.
--   SELECT count(*) FROM chat_messages WHERE content::text ~ 'document://doc_';
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

UPDATE "chat_messages"
SET "content" = regexp_replace(
      "content"::text,
      'document://file_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
      'appfile://file_\1', 'g')::jsonb
WHERE "content"::text ~ 'document://file_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

COMMIT;
