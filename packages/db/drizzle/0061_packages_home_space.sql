-- `packages.home_space_id` — the ONE space whose `<type>:write` authorizes
-- editing, publishing, renaming and deleting a package
-- (`assertPackageMutationAccess`, `apps/api/src/lib/package-access.ts`).
--
-- WHY. Write authority used to be "the caller holds the permission in EVERY
-- space where the package is installed". That rule made an author lose their
-- own package the moment someone installed it into a space the author cannot
-- read, and made a package installed in five spaces editable only by whoever
-- administers all five. Authority now follows a home, and the other
-- installations consume. NULL is the organization catalogue: owners and admins
-- in session, which is the reach `managesOrgCatalog` already described.
--
-- `ON DELETE RESTRICT`, not SET NULL: nulling on a space deletion would
-- silently promote a package to the org catalogue and WIDEN who may write it.
-- Deleting a space that homes packages has to re-home or delete them first.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). Every existing row keeps
-- `home_space_id IS NULL`, i.e. the org catalogue — a NARROWING of who may
-- write a package that is installed somewhere, which is why the column is not
-- backfilled here: choosing a home for a package installed in several spaces
-- is an operator decision, made once, by
-- `scripts/migration/0013-packages-home-space-backfill.sql`. Deploy the way
-- `0008` was deployed: stop the platform, run the migrations only, run 0013,
-- then bring the new version up. Serving traffic in between locks every
-- non-owner author, and every API key, out of its own packages.
--
-- ROLLBACK: safe BEFORE 0013 only. A previous build never reads or writes the
-- column, and the FK accepts the NULLs this file leaves behind. Once 0013 has
-- run, the column names spaces: the old build ignores it, so a rollback is
-- still serviceable, but `DELETE FROM spaces` is not — the `ON DELETE RESTRICT`
-- fires on a space that homes a package and the older build has no route that
-- clears a home. Undo 0013 first (`UPDATE packages SET home_space_id = NULL`)
-- and do it BEFORE any space deletion, not after the first 23503.
--
-- See `scripts/migration/README.md` → "Personal spaces & sharing rollout" for
-- the order this file, 0062, 0063, 0013 and 0014 go in.

ALTER TABLE "packages" ADD COLUMN "home_space_id" text;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_home_space_id_spaces_id_fk" FOREIGN KEY ("home_space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_packages_home_space_id" ON "packages" USING btree ("home_space_id");