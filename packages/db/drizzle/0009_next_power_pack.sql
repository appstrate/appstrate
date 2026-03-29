ALTER TABLE "package_configs" ADD COLUMN "org_profile_id" uuid REFERENCES "connection_profiles"("id") ON DELETE SET NULL;
CREATE INDEX "idx_package_configs_org_profile_id" ON "package_configs" ("org_profile_id");
