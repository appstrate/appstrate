-- Personal spaces — `spaces.owner_user_id` and the offboarding window
-- (`spaces.orphaned_at`).
--
-- WHY. A member has nowhere private to work: every space is a team space, and
-- an organization owner or admin reads all of them. `owner_user_id` names the
-- one member a space belongs to, and `resolveSpaceRole`
-- (`apps/api/src/lib/space-role.ts`) answers on that column BEFORE it looks at
-- the org role — so a personal space is reached by its owner alone and reads as
-- absent (404) to everyone else, admins included. One is provisioned at every
-- membership door (`provisionMember`) and repaired at `GET /api/spaces`.
--
-- The three CHECKs are what make "personal" mean one thing: such a space is
-- always `private`, is never the org's default landing space, and only a
-- personal space can be orphaned. The partial UNIQUE index is both the
-- one-per-member rule and the conflict target `ensurePersonalSpace` upserts on,
-- which is what lets it provision in a single statement instead of racing a
-- select-then-insert.
--
-- `ON DELETE RESTRICT` on the owner: an account deletion must not cascade
-- somebody's private drafts away unreviewed. `orphaned_at` is stamped by
-- `removeMember`, cleared by a re-join, and swept 30 days later by the
-- `personal-space-sweeper` worker, which empties the space and deletes it
-- through the existing `deleteSpace` path.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). Existing rows keep
-- `owner_user_id IS NULL`, i.e. they stay team spaces, so all three CHECKs hold
-- on the whole table at creation and nothing here needs a backfill to be
-- correct. Provisioning the spaces of members who already exist is
-- `scripts/migration/0015-personal-spaces-backfill.sql`, run AFTER the deploy
-- has been validated — it creates one space per membership, which is a cloud
-- plan-limit question first (see the script header).
--
-- ROLLBACK: ONE-WAY from the first boot of the new build, and 0015 has nothing
-- to do with when that starts. `provisionMember` creates a personal space at
-- every membership door and `GET /api/spaces` repairs the caller's own, so
-- personal spaces exist from the first request the new build serves — the
-- script only decides HOW MANY exist, not whether any do.
--
-- What an older build does with them is the reason it is one-way. Its
-- `resolveSpaceRole` does not read `owner_user_id`, so it treats such a space
-- as an ordinary `private` one and grants every organization owner and admin
-- `admin` in it — the one thing §3.6 refuses. And its `PATCH /api/spaces/{id}`
-- can set `visibility` on one, which the CHECK `spaces_personal_is_private`
-- then refuses at the database: a 500, not a validation error.
--
-- Rolling forward is the supported direction, and there is no route that undoes
-- this: a LIVE personal space is convertible by nobody (`convert-to-team` is
-- 409 `personal_space_not_orphaned` on one), by design. A rollback therefore
-- means an operator turning every one of them into an ordinary team space by
-- hand — `UPDATE spaces SET owner_user_id = NULL, orphaned_at = NULL WHERE
-- owner_user_id IS NOT NULL`, which the three CHECKs accept — and accepting
-- that whatever a member kept private in theirs becomes readable by the
-- organization's admins. Restore the coordinated backup instead where one
-- exists.
--
-- See `scripts/migration/README.md` → "Personal spaces & sharing rollout".

ALTER TABLE "spaces" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "orphaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spaces_org_owner" ON "spaces" USING btree ("org_id","owner_user_id") WHERE "spaces"."owner_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_personal_is_private" CHECK (owner_user_id IS NULL OR visibility = 'private');--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_personal_not_default" CHECK (owner_user_id IS NULL OR NOT is_default);--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_orphaned_is_personal" CHECK (orphaned_at IS NULL OR owner_user_id IS NOT NULL);
