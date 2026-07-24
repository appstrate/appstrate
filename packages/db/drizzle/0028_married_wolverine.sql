CREATE TABLE "storage_deletion_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_storage_deletion_jobs_due" ON "storage_deletion_jobs" USING btree ("next_attempt_at") WHERE "storage_deletion_jobs"."completed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_storage_deletion_jobs_pending" ON "storage_deletion_jobs" USING btree ("bucket","storage_key") WHERE "storage_deletion_jobs"."completed_at" IS NULL;
