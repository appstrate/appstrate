ALTER TABLE "runs" ADD COLUMN "version_label" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "version_dirty" boolean DEFAULT false NOT NULL;