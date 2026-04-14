ALTER TABLE "user" ADD COLUMN "realm" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "realm" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
CREATE INDEX "user_realm_idx" ON "user" ("realm");--> statement-breakpoint
CREATE INDEX "session_realm_idx" ON "session" ("realm");
