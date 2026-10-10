CREATE TABLE "user_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid,
	"type" text NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"source_session_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_memories_type_valid" CHECK (type IN ('preference', 'person', 'project', 'goal', 'commitment', 'fact')),
	CONSTRAINT "user_memories_created_by_valid" CHECK (created_by IN ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "assistant_memory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_source_session_id_chat_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_memories_user_org" ON "user_memories" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_user_memories_org" ON "user_memories" USING btree ("org_id") WHERE "user_memories"."org_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_user_memories_source_session" ON "user_memories" USING btree ("source_session_id") WHERE "user_memories"."source_session_id" IS NOT NULL;