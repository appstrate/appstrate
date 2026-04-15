CREATE TABLE IF NOT EXISTS "uploads" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "application_id" text NOT NULL,
  "created_by" text,
  "storage_key" text NOT NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "size" integer NOT NULL,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploads" ADD CONSTRAINT "uploads_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "uploads" ADD CONSTRAINT "uploads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploads_app" ON "uploads" ("application_id");--> statement-breakpoint
-- Partial index tuned for the GC sweep (`expires_at < now() AND consumed_at IS NULL`).
-- Consumed rows never need to be scanned and the hot set stays tiny as successful
-- uploads accumulate over time.
CREATE INDEX IF NOT EXISTS "idx_uploads_expires_unconsumed" ON "uploads" ("expires_at") WHERE "consumed_at" IS NULL;
