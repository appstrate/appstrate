-- Skills in the chat, phase 3: the per-conversation skill SELECTION.
--
-- Shapes only (`docs/NO_TRANSITIONAL_CODE.md` §2) — the WHY of each column is
-- in the drizzle docblocks (`packages/db/src/schema/chat.ts`). The one decision
-- that lives here: `chat_session_skills.package_id` carries a `@scope/name` and
-- has NO foreign key to `packages`. A pin is a user's stated intent about a
-- conversation, not a reference the database must keep satisfiable — the
-- package it names may be deleted, unshared or out of reach on one turn and
-- back the next, and an FK would either destroy the pin (cascade) or block the
-- package's deletion (restrict). The turn re-resolves every pin instead.
--
-- ROLLBACK: safe. A previous build reads neither the column nor the table.

CREATE TABLE "chat_session_skills" (
	"session_id" text NOT NULL,
	"package_id" text NOT NULL,
	CONSTRAINT "chat_session_skills_session_id_package_id_pk" PRIMARY KEY("session_id","package_id")
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_discovery" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_session_skills" ADD CONSTRAINT "chat_session_skills_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_skill_discovery" CHECK ("chat_sessions"."skill_discovery" in ('auto', 'on_demand', 'manual'));
