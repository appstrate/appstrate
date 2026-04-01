-- Replace user_package_profiles (per-package override) with user_flow_provider_profiles (per-provider override)
DROP TABLE IF EXISTS "user_package_profiles";

CREATE TABLE "user_flow_provider_profiles" (
  "user_id" text REFERENCES "user"("id") ON DELETE CASCADE,
  "end_user_id" text REFERENCES "end_users"("id") ON DELETE CASCADE,
  "package_id" text NOT NULL REFERENCES "packages"("id") ON DELETE CASCADE,
  "provider_id" text NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "connection_profiles"("id") ON DELETE CASCADE,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ufpp_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX "idx_ufpp_member" ON "user_flow_provider_profiles" ("user_id", "package_id", "provider_id") WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX "idx_ufpp_end_user" ON "user_flow_provider_profiles" ("end_user_id", "package_id", "provider_id") WHERE end_user_id IS NOT NULL;
CREATE INDEX "idx_ufpp_package_id" ON "user_flow_provider_profiles" ("package_id");
