-- 0009_package_persistence.sql
--
-- Unify `runs.state` + `package_memories` into a single `package_persistence`
-- table with scope (user / end_user / shared) as a first-class dimension.
-- See docs/adr/ADR-011-checkpoint-unification.md.
--
-- This migration is ADDITIVE:
--
--   * creates `package_persistence` with its indexes + CHECK constraints,
--   * back-fills it with existing memories (→ scope=shared) and the most
--     recent non-null `runs.state` per actor (→ kind=checkpoint).
--
-- Legacy stores (`runs.state` column, `package_memories` table) are NOT
-- dropped here. The API double-writes during the transition window; the
-- follow-up migration drops them after stability is confirmed in prod.

CREATE TABLE IF NOT EXISTS "package_persistence" (
  "id"              serial PRIMARY KEY,
  "package_id"      text NOT NULL REFERENCES "packages"("id") ON DELETE CASCADE,
  "application_id"  text NOT NULL REFERENCES "applications"("id") ON DELETE CASCADE,
  "org_id"          uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind"            text NOT NULL,
  "actor_type"      text NOT NULL,
  "actor_id"        text,
  "content"         jsonb NOT NULL,
  "run_id"          text REFERENCES "runs"("id") ON DELETE SET NULL,
  "created_at"      timestamp NOT NULL DEFAULT NOW(),
  "updated_at"      timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT "pkp_kind_valid"       CHECK (kind IN ('checkpoint', 'memory')),
  CONSTRAINT "pkp_actor_type_valid" CHECK (actor_type IN ('user', 'end_user', 'shared')),
  CONSTRAINT "pkp_actor_id_shape"
    CHECK ((actor_type = 'shared' AND actor_id IS NULL)
        OR (actor_type <> 'shared' AND actor_id IS NOT NULL))
);
--> statement-breakpoint

-- Upsert target: at most one checkpoint per (package, app, actor).
-- NULLs in the unique index are treated as DISTINCT by Postgres by default,
-- so two shared checkpoints (actor_id NULL) for the same (package, app)
-- would otherwise BOTH be inserted. Use NULLS NOT DISTINCT so the unique
-- constraint still holds for the shared bucket.
CREATE UNIQUE INDEX IF NOT EXISTS "pkp_checkpoint_unique"
  ON "package_persistence" ("package_id", "application_id", "actor_type", "actor_id")
  NULLS NOT DISTINCT
  WHERE "kind" = 'checkpoint';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pkp_lookup"
  ON "package_persistence" ("package_id", "application_id", "kind", "actor_type", "actor_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pkp_org"
  ON "package_persistence" ("org_id");
--> statement-breakpoint

-- Back-fill existing memories as shared rows. Content becomes a JSONB
-- string; the service layer reads it via a typeof-string guard so legacy
-- content stays intact.
INSERT INTO "package_persistence"
  (package_id, application_id, org_id, kind, actor_type, actor_id, content, run_id, created_at, updated_at)
SELECT
  pm.package_id,
  pm.application_id,
  pm.org_id,
  'memory',
  'shared',
  NULL,
  to_jsonb(pm.content),
  pm.run_id,
  pm.created_at,
  pm.created_at
FROM "package_memories" pm
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Back-fill the latest non-null `runs.state` per (package, app, actor) as
-- a checkpoint. `DISTINCT ON` is Postgres-specific and picks the row with
-- MAX(started_at) per group thanks to the ORDER BY tiebreak.
INSERT INTO "package_persistence"
  (package_id, application_id, org_id, kind, actor_type, actor_id, content, run_id, created_at, updated_at)
SELECT DISTINCT ON (r.package_id, r.application_id, r.dashboard_user_id, r.end_user_id)
  r.package_id,
  r.application_id,
  r.org_id,
  'checkpoint',
  CASE
    WHEN r.end_user_id IS NOT NULL       THEN 'end_user'
    WHEN r.dashboard_user_id IS NOT NULL THEN 'user'
    ELSE 'shared'
  END,
  COALESCE(r.end_user_id, r.dashboard_user_id),
  r.state,
  r.id,
  r.started_at,
  r.started_at
FROM "runs" r
WHERE r.state IS NOT NULL
ORDER BY r.package_id, r.application_id, r.dashboard_user_id, r.end_user_id, r.started_at DESC
ON CONFLICT DO NOTHING;
