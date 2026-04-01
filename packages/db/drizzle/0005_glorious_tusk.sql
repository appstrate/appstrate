ALTER TABLE "webhooks" ALTER COLUMN "application_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "scope" text DEFAULT 'application' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_webhooks_scope_org" ON "webhooks" USING btree ("scope","org_id","active");