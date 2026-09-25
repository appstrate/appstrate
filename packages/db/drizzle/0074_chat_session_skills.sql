-- Skills in the chat: the per-conversation skill selection. Shape only.
-- ROLLBACK: nothing to undo — a previous build reads neither column. Do not
-- drop them: 0074 stays in the journal, so a later redeploy would not re-add them.

ALTER TABLE "chat_sessions" ADD COLUMN "skill_catalogue" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "pinned_skills" text[] DEFAULT '{}'::text[] NOT NULL;
