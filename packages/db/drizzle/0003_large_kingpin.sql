ALTER TABLE "user" ADD COLUMN "source" text DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "idx_user_external_id" ON "user" USING btree ("external_id");