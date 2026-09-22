-- The `UPDATE` below is licensed by `docs/NO_TRANSITIONAL_CODE.md` §2, "the
-- precondition of a constraint": `SET NOT NULL` scans the existing rows and
-- fails on the first NULL, so the backfill cannot be separated from the
-- promotion it preconditions — same table, one `UPDATE`, and re-running it
-- matches zero rows (`WHERE label IS NULL` is the exact inverse of the scan).
-- It mints what the service mints on every insert: "Connexion N", N being the
-- row's rank by `created_at` inside its (space, integration, owner) group.
DROP INDEX "idx_integration_pins_unique";--> statement-breakpoint
DROP INDEX "idx_integration_org_defaults_unique";--> statement-breakpoint
UPDATE "integration_connections" c SET "label" = 'Connexion ' || r.rank FROM (SELECT "id", row_number() OVER (PARTITION BY "space_id", "integration_package_id", coalesce("user_id", "end_user_id") ORDER BY "created_at", "id") AS rank FROM "integration_connections" WHERE "label" IS NULL) r WHERE c."id" = r."id" AND c."label" IS NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_pins_unique" ON "integration_pins" USING btree ("space_id","package_id","integration_package_id",coalesce("user_id", ''),"connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_org_defaults_unique" ON "integration_org_defaults" USING btree ("space_id","integration_package_id","connection_id");