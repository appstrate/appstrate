CREATE TABLE "run_persistence_operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"kind" text NOT NULL,
	"outcome" text NOT NULL,
	"committed_revision" integer,
	"target_key" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rpo_kind_valid" CHECK (kind IN ('memory', 'slot')),
	CONSTRAINT "rpo_outcome_valid" CHECK (outcome IN ('committed', 'rejected', 'conflict'))
);
--> statement-breakpoint
ALTER TABLE "package_persistence" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "actor_type_snapshot" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "actor_id_snapshot" text;--> statement-breakpoint
ALTER TABLE "run_persistence_operations" ADD CONSTRAINT "run_persistence_operations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rpo_run_operation_unique" ON "run_persistence_operations" USING btree ("run_id","operation_id");--> statement-breakpoint
-- Backfill the actor snapshot for runs that can still write memory.
--
-- Terminal runs are skipped on purpose: they will never resolve a persistence
-- scope again, so snapshotting them would be a full-table rewrite with no
-- reader. Non-terminal rows are bounded by the platform's concurrency caps.
-- Readers fall back to the (user_id, end_user_id) pair when the snapshot is
-- NULL, so an un-backfilled row keeps exactly today's behaviour.
UPDATE "runs"
SET "actor_type_snapshot" = CASE
      WHEN "user_id" IS NOT NULL THEN 'user'
      WHEN "end_user_id" IS NOT NULL THEN 'end_user'
      ELSE 'shared'
    END,
    "actor_id_snapshot" = COALESCE("user_id", "end_user_id")
WHERE "status" IN ('pending', 'running')
  AND "actor_type_snapshot" IS NULL;
