-- Drop the `documents.presentation` concept (issue #1177, phase 1a).
--
-- `presentation` conflated two things: how important a file is, and whether the
-- UI opens it. It forced the agent to make a presentation decision that was
-- never its call. It is replaced by a purely derived, client-side rule over the
-- run's `agent_output` documents — 0 produced → nothing; exactly 1 → shown by
-- default; N → a list the user picks from. Nothing server-side implements that
-- rule, so nothing server-side stores it either.
--
-- FORWARD-ONLY. The dropped column carried no information the derived rule
-- needs: `presentation = 'primary'` was a hint, never a container or an ACL.
--
-- Order matters: the partial unique index and the CHECK constraint both
-- reference the column, so both must go first. `IF EXISTS` on every statement
-- so a partially-migrated environment converges instead of erroring.
DROP INDEX IF EXISTS "uq_documents_run_primary";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "chk_documents_presentation";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "presentation";
