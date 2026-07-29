ALTER TABLE "runs" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "compaction_threshold" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_context_window_positive" CHECK (context_window > 0);--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_compaction_threshold_within_window" CHECK (compaction_threshold IS NULL OR (context_window IS NOT NULL AND compaction_threshold > 0 AND compaction_threshold < context_window));