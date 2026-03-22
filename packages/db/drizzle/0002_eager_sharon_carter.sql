CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
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
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"flow_id" text,
	"payload_mode" text DEFAULT 'full' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "source" text DEFAULT 'dashboard' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_event_id" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_status" ON "webhook_deliveries" USING btree ("webhook_id","status");--> statement-breakpoint
CREATE INDEX "idx_webhooks_org_id" ON "webhooks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_org_active" ON "webhooks" USING btree ("org_id","active");--> statement-breakpoint
CREATE INDEX "idx_user_external_id" ON "user" USING btree ("external_id");