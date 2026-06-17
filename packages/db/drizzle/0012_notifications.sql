CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text,
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
-- Backfill (issue #667): migrate the run-row notification state
-- (runs.notified_at / runs.read_at) into per-recipient notification rows.
-- created_at is set to the original notified_at to preserve ordering, and
-- read_at is copied verbatim so existing read state is preserved.
-- Each INSERT carries ON CONFLICT DO NOTHING so a re-apply (e.g. after the
-- prod __drizzle_migrations watermark is realigned) collides harmlessly with
-- the (run_id, recipient, type) unique indexes instead of aborting the
-- migration. The three branches partition runs on mutually exclusive
-- predicates (the runs `at_most_one_actor` CHECK guarantees no run has both a
-- user and an end-user), so within a single apply no row is inserted twice.
-- 1. Dashboard-user runs → one row for the triggering user.
INSERT INTO "notifications" ("org_id", "application_id", "user_id", "type", "run_id", "payload", "read_at", "created_at")
SELECT r."org_id", r."application_id", r."user_id", 'run_completed', r."id",
       jsonb_build_object('agent_id', r."package_id", 'status', r."status"),
       r."read_at", r."notified_at"
FROM "runs" r
WHERE r."notified_at" IS NOT NULL AND r."user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. End-user runs (no dashboard user) → one row for the end-user.
INSERT INTO "notifications" ("org_id", "application_id", "end_user_id", "type", "run_id", "payload", "read_at", "created_at")
SELECT r."org_id", r."application_id", r."end_user_id", 'run_completed', r."id",
       jsonb_build_object('agent_id', r."package_id", 'status', r."status"),
       r."read_at", r."notified_at"
FROM "runs" r
WHERE r."notified_at" IS NOT NULL AND r."user_id" IS NULL AND r."end_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 3. Actor-less runs (no user, no end-user) → one row per org admin/owner,
--    copying read_at to each (the old global flag's effect, bounded to the
--    members who manage org/system schedules — see createRunNotifications).
INSERT INTO "notifications" ("org_id", "application_id", "user_id", "type", "run_id", "payload", "read_at", "created_at")
SELECT r."org_id", r."application_id", m."user_id", 'run_completed', r."id",
       jsonb_build_object('agent_id', r."package_id", 'status', r."status"),
       r."read_at", r."notified_at"
FROM "runs" r
JOIN "org_members" m ON m."org_id" = r."org_id" AND m."role" IN ('owner', 'admin')
WHERE r."notified_at" IS NOT NULL AND r."user_id" IS NULL AND r."end_user_id" IS NULL
ON CONFLICT DO NOTHING;