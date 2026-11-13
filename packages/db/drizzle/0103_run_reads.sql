-- A finished run's read state, per recipient, moves out of `notifications` into a table of its own:
-- a run is unread whether or not anyone was notified about it. Schema only. The existing read state
-- (`notifications` rows of type `run_completed`) is copied by `scripts/migration/0052-run-reads.sql`,
-- run in the release window; until then runs finished before the deploy show as read.
CREATE TABLE "run_reads" (
	"run_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" text NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_reads_run_id_recipient_type_recipient_id_pk" PRIMARY KEY("run_id","recipient_type","recipient_id"),
	CONSTRAINT "run_reads_recipient_type_valid" CHECK (recipient_type IN ('user', 'end_user'))
);
--> statement-breakpoint
ALTER TABLE "run_reads" ADD CONSTRAINT "run_reads_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reads" ADD CONSTRAINT "run_reads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_reads" ADD CONSTRAINT "run_reads_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_reads_unread" ON "run_reads" USING btree ("org_id","space_id","recipient_type","recipient_id") WHERE "run_reads"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_run_reads_recipient" ON "run_reads" USING btree ("org_id","recipient_type","recipient_id","space_id");--> statement-breakpoint
CREATE INDEX "idx_run_reads_space" ON "run_reads" USING btree ("space_id");