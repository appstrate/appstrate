-- Chat skills held by the server: who pinned each skill (`assistant_skills`, the part of
-- `pinned_skills` the assistant pinned by loading a SKILL.md) and what the last turn that
-- claimed the conversation did with each pin (`skill_status`). DDL only: an existing pin
-- reads as the user's, with no status until its next turn. Two CHECKs keep the assistant's pins
-- among the pins and the pins within the chat's cap of 5 (every API write already did).
-- Rollback: drop both constraints, then both columns.

ALTER TABLE "chat_sessions" ADD COLUMN "assistant_skills" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_status" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_assistant_skills_pinned" CHECK (assistant_skills <@ pinned_skills);--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_pinned_skills_cap" CHECK (cardinality(pinned_skills) <= 5);
