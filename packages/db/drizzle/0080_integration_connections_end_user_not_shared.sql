-- Only a member shares a connection: an end user's connection serves that end
-- user's runs, so it never enters an admin pin or an org default, and the
-- `end_user_id` cascade of an end user's deletion strands no id in either set
-- (#1775).
--
-- The `CHECK` scans the rows that exist, so its precondition is that no end
-- user's connection is shared. That repair is NOT made here: it also rewrites
-- `integration_pins` and `integration_org_defaults`, which this constraint does
-- not licence (`docs/NO_TRANSITIONAL_CODE.md` §2). The read-only DO block
-- refuses, before any change, a database where
-- `scripts/migration/0036-unshare-end-user-connections.sql` has not run: a shared
-- end user's connection (the `CHECK` would refuse it as a bare 23514), or an
-- admin pin or org default naming an end user's connection, which no
-- constraint catches.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "integration_connections" WHERE "end_user_id" IS NOT NULL AND "shared_with_org")
    OR EXISTS (SELECT 1 FROM "integration_pins" p JOIN "integration_connections" c ON c."id" = ANY (p."connection_ids") WHERE p."user_id" IS NULL AND c."end_user_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "integration_org_defaults" d JOIN "integration_connections" c ON c."id" = ANY (d."connection_ids") WHERE c."end_user_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'An end user''s connection is shared with the organization, or named by an admin pin or an org default. Run scripts/migration/0036-unshare-end-user-connections.sql, then redeploy.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_end_user_not_shared" CHECK (NOT shared_with_org OR user_id IS NOT NULL);
