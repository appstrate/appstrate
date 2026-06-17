CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"type" text NOT NULL,
	"run_id" text,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_type_valid" CHECK (recipient_type IN ('user', 'end_user'))
);
--> statement-breakpoint
DROP INDEX "idx_runs_notification";--> statement-breakpoint
DROP INDEX "idx_runs_unread";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_feed" ON "notifications" USING btree ("org_id","application_id","recipient_type","recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_notifications_unread" ON "notifications" USING btree ("org_id","application_id","recipient_type","recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_run" ON "notifications" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_run_recipient_type" ON "notifications" USING btree ("run_id","recipient_type","recipient_id","type") WHERE "notifications"."run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "notified_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "read_at";