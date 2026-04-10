-- Webhooks module: initial schema

CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "application_id" text NOT NULL REFERENCES "applications" ("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "events" text[] NOT NULL,
  "package_id" text REFERENCES "packages" ("id") ON DELETE SET NULL,
  "payload_mode" text DEFAULT 'full' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "secret" text NOT NULL,
  "previous_secret" text,
  "previous_secret_expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "webhook_id" text NOT NULL REFERENCES "webhooks" ("id") ON DELETE CASCADE,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "status_code" integer,
  "latency" integer,
  "attempt" integer DEFAULT 1 NOT NULL,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_org_id" ON "webhooks" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_application_id" ON "webhooks" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhooks_app_enabled" ON "webhooks" USING btree ("application_id", "enabled");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_event_id" ON "webhook_deliveries" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_status" ON "webhook_deliveries" USING btree ("webhook_id", "status");
