-- Only a member shares a connection (#1775; see the CHECK on `integration_connections` in
-- `packages/db/src/schema/integrations.ts`).
--
-- The CHECK scans existing rows, and its repair also rewrites admin pins and org defaults, which it
-- does not licence (`docs/NO_TRANSITIONAL_CODE.md` §2): that is
-- `scripts/migration/0036-unshare-end-user-connections.sql`. The read-only DO block refuses the
-- batch while an end user's connection is shared (the CHECK would fail as a bare 23514) or named by
-- an admin pin or an org default (no constraint catches it), naming that script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "integration_connections" WHERE "end_user_id" IS NOT NULL AND "shared_with_org")
    OR EXISTS (SELECT 1 FROM "integration_pins" p JOIN "integration_connections" c ON c."id" = ANY (p."connection_ids") WHERE p."user_id" IS NULL AND c."end_user_id" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "integration_org_defaults" d JOIN "integration_connections" c ON c."id" = ANY (d."connection_ids") WHERE c."end_user_id" IS NOT NULL)
  THEN
    RAISE EXCEPTION 'An end user''s connection is shared with the organization, or named by an admin pin or an org default. Stop the app, run scripts/migration/0036-unshare-end-user-connections.sql, then redeploy.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_end_user_not_shared" CHECK (NOT shared_with_org OR user_id IS NOT NULL);
