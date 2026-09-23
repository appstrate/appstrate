-- A pin and an org default each bind a SET of connections: one row per key,
-- `connection_ids uuid[]` instead of the scalar `connection_id`.
--
-- The two `ARRAY["connection_id"]` UPDATEs are folds whose source column is
-- dropped in this file, and the `label` UPDATE is the precondition of the
-- `SET NOT NULL` and `CHECK` on `integration_connections` —
-- `docs/NO_TRANSITIONAL_CODE.md` §2 licenses all three.
--
-- `DROP COLUMN "connection_id"` takes its FK and its btree index with it
-- whatever the catalog calls them, so neither is dropped by name: production's
-- constraint names have drifted from the declared ones before.
--
-- The label backfill mints what the service mints: "Connexion N", N counting on
-- from the highest "Connexion <n>" already in the (space, integration) group,
-- every owner included, so it can never mint a label the group already holds.
ALTER TABLE "integration_pins" ADD COLUMN "connection_ids" uuid[];--> statement-breakpoint
UPDATE "integration_pins" SET "connection_ids" = ARRAY["connection_id"];--> statement-breakpoint
ALTER TABLE "integration_pins" ALTER COLUMN "connection_ids" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_pins" DROP COLUMN "connection_id";--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_connection_ids_cardinality" CHECK (cardinality(connection_ids) BETWEEN 1 AND 10);--> statement-breakpoint
CREATE INDEX "idx_integration_pins_connection_ids" ON "integration_pins" USING gin ("connection_ids");--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD COLUMN "connection_ids" uuid[];--> statement-breakpoint
UPDATE "integration_org_defaults" SET "connection_ids" = ARRAY["connection_id"];--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ALTER COLUMN "connection_ids" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_org_defaults" DROP COLUMN "connection_id";--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_connection_ids_cardinality" CHECK (cardinality(connection_ids) BETWEEN 1 AND 10);--> statement-breakpoint
CREATE INDEX "idx_integration_org_defaults_connection_ids" ON "integration_org_defaults" USING gin ("connection_ids");--> statement-breakpoint
UPDATE "integration_connections" c SET "label" = 'Connexion ' || (g."base" + f."rank") FROM (SELECT "id", "space_id", "integration_package_id", row_number() OVER (PARTITION BY "space_id", "integration_package_id" ORDER BY "created_at", "id") AS "rank" FROM "integration_connections" WHERE "label" IS NULL OR "label" = '') f JOIN (SELECT "space_id", "integration_package_id", coalesce(max(substring("label" FROM '^Connexion ([0-9]+)$')::numeric), 0) AS "base" FROM "integration_connections" GROUP BY "space_id", "integration_package_id") g ON g."space_id" = f."space_id" AND g."integration_package_id" = f."integration_package_id" WHERE c."id" = f."id";--> statement-breakpoint
ALTER TABLE "integration_connections" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_label_not_empty" CHECK (label <> '');
