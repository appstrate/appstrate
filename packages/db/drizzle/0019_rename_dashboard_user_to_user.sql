-- Rename `runs.dashboard_user_id` to `runs.user_id`.
--
-- The platform used three vocabularies for the same entity (the
-- authenticated dashboard human triggering a run): `Actor.type='member'`
-- (in-process), `runs.dashboard_user_id` (this column), and
-- `package_persistence.actor_type='user'` (already canonical). This
-- migration unifies on `user` everywhere — column renamed here, the
-- in-process `Actor.type` flipped from `'member'` to `'user'` in the
-- same change set, audit_events.actor_type literal value flipped
-- accordingly. `package_persistence.actor_type` was already `'user'`.
--
-- Also renames the dependent index, FK constraint, and CHECK constraint
-- so the schema names match the new column name byte-for-byte (otherwise
-- drizzle-kit diff would flag them as drift on the next generate).
--
-- Idempotent shape via `IF EXISTS` so partial reapply (e.g. a botched
-- previous deploy) is safe.

ALTER TABLE "runs" RENAME COLUMN "dashboard_user_id" TO "user_id";

ALTER INDEX IF EXISTS "idx_runs_dashboard_user_id" RENAME TO "idx_runs_user_id";

ALTER TABLE "runs" RENAME CONSTRAINT "runs_dashboard_user_id_user_id_fk" TO "runs_user_id_user_id_fk";

-- The `runs_at_most_one_actor` CHECK references `dashboard_user_id` in its
-- expression. PostgreSQL stores the expression with the new column name
-- automatically after RENAME COLUMN, so the constraint still works — but
-- recreate it under a stable name with the explicit new column to keep
-- the schema definition matching the Drizzle model.
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_at_most_one_actor";
ALTER TABLE "runs" ADD CONSTRAINT "runs_at_most_one_actor"
  CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL));

-- audit_events.actor_type is open-ended TEXT (no enum). Flip historic
-- 'member' rows to 'user' so the new in-process discriminant matches the
-- persisted vocabulary. No CHECK constraint to update.
UPDATE "audit_events" SET "actor_type" = 'user' WHERE "actor_type" = 'member';
