-- Chat skills: the three skill modes (auto | manual | strict) become two settings,
-- `pinned_skills` (always injected) and `skill_discovery` (the model may find others), and
-- the server records what the last turn that claimed the conversation did with each pin
-- (`skill_status`).
-- Fold of `skill_mode`: strict -> discovery off. auto -> no pins: its pins were kept but
-- unused, and would otherwise be injected overnight.
-- Both UPDATEs live here, not in a script under scripts/migration/: the first folds a
-- column dropped in this file; the second rewrites a surviving column, but the only
-- thing it reads ("these pins were inactive") lives in `skill_mode`, which is dropped
-- below, so a later operator script would have nothing to read.
-- Every surviving pin has no status until its next turn; `manual`/`strict` rows keep their pins.
-- Rollback: the old modes cannot be rebuilt and the `auto` pins are gone; restore a backup.
-- The previous code reads `skill_mode`, dropped here, so it cannot run on this schema.

ALTER TABLE "chat_sessions" ADD COLUMN "skill_discovery" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_status" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "chat_sessions" SET "skill_discovery" = false WHERE "skill_mode" = 'strict';--> statement-breakpoint
UPDATE "chat_sessions" SET "pinned_skills" = '{}' WHERE "skill_mode" = 'auto' AND "pinned_skills" <> '{}';--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "skill_mode";--> statement-breakpoint
DROP TYPE "public"."chat_skill_mode";
