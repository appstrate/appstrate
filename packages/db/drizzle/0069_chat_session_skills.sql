-- Skills in the chat, phase 3: the per-conversation skill SELECTION.
--
-- Two halves of one choice. `chat_sessions.skill_discovery` is how much of the
-- space's skill catalogue a conversation indexes — `auto` (platform defaults +
-- pins + catalogue), `on_demand` (defaults + pins) or `manual` (pins only). It
-- lives on the session row, not in a side table: every turn reads that row
-- already (`ensureSession` returns it), so the mode costs no extra query on the
-- pre-inference path. `DEFAULT 'auto'` is what makes the column addable to a
-- populated table in one statement — every existing conversation keeps exactly
-- the behaviour it had before this migration. The CHECK closes the value set in
-- the database as well as in the Zod enum, so an unknown mode cannot be stored
-- and then silently degrade to `auto` at render time.
--
-- `chat_session_skills` is the pin set: (session, package id), no more — the
-- composite primary key IS the whole row. No `created_at`: `setSessionSkills`
-- rewrites the set wholesale, so such a column would date the last write of the
-- set rather than the pin, and nothing reads it. There is
-- deliberately NO foreign key on `package_id` — a pin is a user's stated intent
-- about a conversation, not a reference the database must keep satisfiable. The
-- package it names can be deleted, unshared, deactivated in this space or out of
-- the caller's reach on one turn and back the next; an FK would either destroy
-- the pin (cascade) or block the package's deletion (restrict), and neither is
-- what a pin means. The turn re-resolves every pin against `skills:read` and the
-- space's active set, and renders one deterministic notice line for what does
-- not answer. The SESSION half is a real FK with ON DELETE CASCADE: a pin
-- outside its conversation means nothing.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2): a new column with a default
-- and a brand-new table, nothing to backfill, no operator script.
--
-- ROLLBACK: safe. A previous build reads neither the column nor the table, and
-- the rows left behind are inert.

CREATE TABLE "chat_session_skills" (
	"session_id" text NOT NULL,
	"package_id" text NOT NULL,
	CONSTRAINT "chat_session_skills_session_id_package_id_pk" PRIMARY KEY("session_id","package_id")
);
--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "skill_discovery" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_session_skills" ADD CONSTRAINT "chat_session_skills_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_skill_discovery" CHECK ("chat_sessions"."skill_discovery" in ('auto', 'on_demand', 'manual'));
