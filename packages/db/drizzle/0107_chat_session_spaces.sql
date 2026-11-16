-- A conversation's `space_id` becomes its ORIGIN space (nullable: NULL = created from the
-- overview), and `restricted` confines it to that space. `chat_session_spaces` records the
-- other spaces a conversation touched.
ALTER TABLE "chat_sessions" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD COLUMN "restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "chat_session_spaces" (
	"session_id" text NOT NULL,
	"space_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_session_spaces_session_id_space_id_pk" PRIMARY KEY("session_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "chat_session_spaces" ADD CONSTRAINT "chat_session_spaces_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_session_spaces" ADD CONSTRAINT "chat_session_spaces_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_session_spaces_space" ON "chat_session_spaces" USING btree ("space_id");--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_restricted_needs_space" CHECK (restricted = false OR space_id IS NOT NULL);
