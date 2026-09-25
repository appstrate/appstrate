-- Skills in the chat: the per-conversation skill mode and chosen skills. Shape only.
-- ROLLBACK: nothing to undo — a previous build reads neither column. Do not
-- drop them: 0074 stays in the journal, so a later redeploy would not re-add them.

CREATE TYPE "public"."chat_skill_mode" AS ENUM('auto', 'manual', 'strict');--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_mode" "chat_skill_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "pinned_skills" text[] DEFAULT '{}'::text[] NOT NULL;
