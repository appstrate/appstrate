DROP INDEX "idx_service_connections_unique";--> statement-breakpoint
-- Delete existing service connections (no orgId to backfill in dev)
DELETE FROM "service_connections";--> statement-breakpoint
ALTER TABLE "service_connections" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_service_connections_org_id" ON "service_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_connections_unique" ON "service_connections" USING btree ("profile_id","provider_id","org_id");