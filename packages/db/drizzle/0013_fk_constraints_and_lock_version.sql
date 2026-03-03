-- Migration 0013: FK constraints, onDelete cascade, lock version column
-- Phase 1.1: FK on packageId (5 tables)
-- Phase 1.2: onDelete cascade on orgId (7 tables) + oauthStates.orgId FK
-- Phase 1.3: Index on userPackageProfiles.packageId
-- Phase 1.5: Optimistic lock version column on packages

-- ============================================================
-- Step 0: Clean up orphan rows before adding FK constraints
-- ============================================================

DELETE FROM "executions" WHERE "package_id" IS NOT NULL AND "package_id" NOT IN (SELECT "id" FROM "packages");
--> statement-breakpoint
DELETE FROM "package_memories" WHERE "package_id" NOT IN (SELECT "id" FROM "packages");
--> statement-breakpoint
DELETE FROM "package_schedules" WHERE "package_id" NOT IN (SELECT "id" FROM "packages");
--> statement-breakpoint
DELETE FROM "share_tokens" WHERE "package_id" NOT IN (SELECT "id" FROM "packages");
--> statement-breakpoint
DELETE FROM "user_package_profiles" WHERE "package_id" NOT IN (SELECT "id" FROM "packages");
--> statement-breakpoint
DELETE FROM "package_admin_connections" WHERE "package_id" NOT IN (SELECT "id" FROM "packages");

--> statement-breakpoint

-- ============================================================
-- Step 1: packages.version (optimistic lock column)
-- ============================================================

ALTER TABLE "packages" ADD COLUMN "version" integer NOT NULL DEFAULT 1;

--> statement-breakpoint

-- ============================================================
-- Step 2: executions.package_id — make nullable + add FK SET NULL
-- ============================================================

ALTER TABLE "executions" ALTER COLUMN "package_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "executions"
  ADD CONSTRAINT "executions_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL;

--> statement-breakpoint

-- ============================================================
-- Step 3: executions.org_id — upgrade to ON DELETE CASCADE
-- ============================================================

ALTER TABLE "executions" DROP CONSTRAINT "executions_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "executions"
  ADD CONSTRAINT "executions_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 4: execution_logs.org_id — upgrade to ON DELETE CASCADE
-- ============================================================

ALTER TABLE "execution_logs" DROP CONSTRAINT "execution_logs_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_logs"
  ADD CONSTRAINT "execution_logs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 5: package_memories.package_id — add FK CASCADE
-- (org_id already has ON DELETE CASCADE from migration 0000)
-- ============================================================

ALTER TABLE "package_memories"
  ADD CONSTRAINT "package_memories_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 6: package_schedules.package_id — add FK CASCADE
-- ============================================================

ALTER TABLE "package_schedules"
  ADD CONSTRAINT "package_schedules_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- Step 6b: package_schedules.org_id — upgrade to ON DELETE CASCADE

ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "package_schedules"
  ADD CONSTRAINT "package_schedules_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 7: share_tokens.package_id — add FK CASCADE
-- ============================================================

ALTER TABLE "share_tokens"
  ADD CONSTRAINT "share_tokens_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- Step 7b: share_tokens.org_id — upgrade to ON DELETE CASCADE

ALTER TABLE "share_tokens" DROP CONSTRAINT "share_tokens_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "share_tokens"
  ADD CONSTRAINT "share_tokens_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 8: user_package_profiles.package_id — add FK CASCADE + index
-- ============================================================

ALTER TABLE "user_package_profiles"
  ADD CONSTRAINT "user_package_profiles_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "idx_user_package_profiles_package_id" ON "user_package_profiles" USING btree ("package_id");

--> statement-breakpoint

-- ============================================================
-- Step 9: package_admin_connections.package_id — add FK CASCADE
-- ============================================================

ALTER TABLE "package_admin_connections"
  ADD CONSTRAINT "package_admin_connections_package_id_packages_id_fk"
  FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- Step 9b: package_admin_connections.org_id — upgrade to ON DELETE CASCADE

ALTER TABLE "package_admin_connections" DROP CONSTRAINT "package_admin_connections_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "package_admin_connections"
  ADD CONSTRAINT "package_admin_connections_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 10: package_configs.org_id — upgrade to ON DELETE CASCADE
-- ============================================================

ALTER TABLE "package_configs" DROP CONSTRAINT "package_configs_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "package_configs"
  ADD CONSTRAINT "package_configs_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;

--> statement-breakpoint

-- ============================================================
-- Step 11: oauth_states.org_id — add FK CASCADE (was missing entirely)
-- ============================================================

ALTER TABLE "oauth_states"
  ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
