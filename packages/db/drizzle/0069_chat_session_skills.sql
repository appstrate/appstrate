-- Skills in the chat: the per-conversation skill selection. Shape only.
-- ROLLBACK: safe — a previous build reads neither column; to drop them:
--   ALTER TABLE "chat_sessions" DROP COLUMN "skill_catalogue", DROP COLUMN "pinned_skills";

ALTER TABLE "chat_sessions" ADD COLUMN "skill_catalogue" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "pinned_skills" text[] DEFAULT '{}'::text[] NOT NULL;
