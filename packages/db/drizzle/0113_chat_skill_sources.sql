-- Chat skills held by the server: who pinned each skill (`assistant_skills`, the part of
-- `pinned_skills` the assistant pinned by loading a SKILL.md) and what the last turn that
-- claimed the conversation did with each pin (`skill_status`). DDL only: an existing pin
-- reads as the user's, with no status until its next turn.
-- Rollback: drop both columns.

ALTER TABLE "chat_sessions" ADD COLUMN "assistant_skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_status" jsonb DEFAULT '{}'::jsonb NOT NULL;
