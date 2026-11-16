-- A conversation belongs to the organization and its author, with no owning space:
-- `chat_sessions.space_id` gives way to `chat_session_spaces`, the spaces it TOUCHED.
-- Each existing session's former space is copied there by
-- `scripts/migration/0055-chat-sessions-touched-space.ts`, run BEFORE this migration (it
-- creates the table, exactly as below, when it is missing): the guard refuses to drop the
-- column while a session's space is not recorded, so no conversation loses its space.
CREATE TABLE IF NOT EXISTS "chat_session_spaces" (
	"session_id" text NOT NULL,
	"space_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_session_spaces_session_id_space_id_pk" PRIMARY KEY("session_id","space_id"),
	CONSTRAINT "chat_session_spaces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "chat_session_spaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_session_spaces_space" ON "chat_session_spaces" USING btree ("space_id");--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "chat_sessions" s
		WHERE s."space_id" IS NOT NULL
			AND NOT EXISTS (
				SELECT 1 FROM "chat_session_spaces" t
				WHERE t."session_id" = s."id" AND t."space_id" = s."space_id"
			)
	) THEN
		RAISE EXCEPTION 'chat_sessions.space_id is dropped only once every session records its space in chat_session_spaces: run scripts/migration/0055-chat-sessions-touched-space.ts --apply, then migrate again';
	END IF;
END $$;--> statement-breakpoint
DROP INDEX "idx_chat_sessions_space_user";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_space_id_spaces_id_fk";--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "space_id";
