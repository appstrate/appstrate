-- 0006 — fold `toolStepBudgetReached` into `maxStepsReached` on stored chat turns.
--
-- Why this exists: `turnLimitReached` (`@appstrate/core/chat-turn-metadata`)
-- read `maxStepsReached || toolStepBudgetReached`. Today's single writer
-- (`pi-turn-closure.ts`) sets BOTH from one expression (`input.stepCapReached`),
-- so for every row written now the two are identical and the `||`'s second arm
-- can only ever change the answer for historical rows. That is a dual-read
-- path no test exercises on purpose — `docs/NO_TRANSITIONAL_CODE.md` §1.
--
-- The code was collapsed to `maxStepsReached` alone. This script moves the data
-- that collapse would otherwise re-answer, per §1 ("the data is wrong, not the
-- validator") and the retirement procedure's step 2.
--
-- WHAT IS ACTUALLY AT RISK — narrower than the retired comment claimed. The
-- shape gate in `turnMetadataFromMessage` already requires
-- `typeof turn.maxStepsReached === "boolean"`, so a turn carrying
-- `toolStepBudgetReached` ALONE never decodes at all and `turnLimitReached`
-- answers false for it with or without the `||`. The only rows the second arm
-- can speak for are those carrying BOTH, with `maxStepsReached: false` and
-- `toolStepBudgetReached: true` — a single writer that set them differently.
-- Those are the rows this folds, and nothing else.
--
-- Scope: UNMEASURED. The divergent pair requires a writer whose git history is
-- squashed in this repo, so whether any deployment holds such a row could not
-- be established from source — only a production query can. Per
-- `scripts/migration/README.md` requirement 4, the counts are marked unmeasured
-- rather than given a value nobody observed. Run the "before" query first: if
-- it returns 0, this deployment needs nothing and the UPDATE is a no-op.
--
-- Idempotent: the WHERE clause is exactly the condition the UPDATE removes, so
-- a second run matches zero rows.
--
-- ═══ VERIFY — the query must DISCRIMINATE ═══
--
--   -- Before: N divergent, M already-true. After: 0 divergent, N+M true.
--   SELECT
--     (SELECT count(*) FROM chat_messages
--        WHERE content #> '{metadata,appstrate,turn,maxStepsReached}' = 'false'::jsonb
--          AND content #> '{metadata,appstrate,turn,toolStepBudgetReached}' = 'true'::jsonb),
--     (SELECT count(*) FROM chat_messages
--        WHERE content #> '{metadata,appstrate,turn,maxStepsReached}' = 'true'::jsonb);
--
--   -- Must be unchanged before AND after: rows that decode at all. The fold
--   -- edits one leaf and must not add, drop, or reshape a turn object.
--   SELECT count(*) FROM chat_messages
--     WHERE jsonb_typeof(content #> '{metadata,appstrate,turn,maxStepsReached}') = 'boolean';
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

UPDATE "chat_messages"
SET "content" = jsonb_set(
      "content",
      '{metadata,appstrate,turn,maxStepsReached}',
      'true'::jsonb,
      false)
WHERE "content" #> '{metadata,appstrate,turn,maxStepsReached}' = 'false'::jsonb
  AND "content" #> '{metadata,appstrate,turn,toolStepBudgetReached}' = 'true'::jsonb;

COMMIT;
