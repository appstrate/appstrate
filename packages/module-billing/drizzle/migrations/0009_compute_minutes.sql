-- Compute-minutes quota: the per-org monthly counter (`ee_compute_usage`), the per-run
-- settlement claims (`ee_settled_runs`) and the watermark of the sweep over finished runs
-- (`ee_compute_cursor`). SHAPE ONLY: the watermark's single row is seeded by the module's
-- `init()` (`ensureComputeCursorSeeded`), at the moment it first runs, so a run that finished
-- before the module metered compute is never billed retroactively.
--
-- ROLLBACK: one-way once runs have been settled (the counters hold the month's consumption).
-- Dropping the three tables is safe for a build that predates them; nothing else references them.
CREATE TABLE "ee_compute_cursor" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"run_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ee_compute_cursor_single_row" CHECK ("ee_compute_cursor"."id")
);
--> statement-breakpoint
CREATE TABLE "ee_compute_usage" (
	"org_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"seconds_used" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ee_compute_usage_org_id_period_start_pk" PRIMARY KEY("org_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "ee_settled_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"seconds" integer NOT NULL,
	"period_start" date NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ee_settled_runs_org_id" ON "ee_settled_runs" USING btree ("org_id");
