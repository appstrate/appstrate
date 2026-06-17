CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"type" text NOT NULL,
	"run_id" text,
	"payload" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_one_recipient" CHECK (("notifications"."user_id" IS NULL) <> ("notifications"."end_user_id" IS NULL))
);
--> statement-breakpoint
DROP INDEX "idx_runs_notification";--> statement-breakpoint
DROP INDEX "idx_runs_unread";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_unread_user" ON "notifications" USING btree ("org_id","application_id","user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_unread_end_user" ON "notifications" USING btree ("org_id","application_id","end_user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notifications_run" ON "notifications" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_run_user_type" ON "notifications" USING btree ("run_id","user_id","type") WHERE "notifications"."user_id" IS NOT NULL AND "notifications"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_run_end_user_type" ON "notifications" USING btree ("run_id","end_user_id","type") WHERE "notifications"."end_user_id" IS NOT NULL AND "notifications"."run_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "notified_at";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "read_at";