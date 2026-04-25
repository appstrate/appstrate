-- 0010_package_persistence.sql
--
-- Unify `runs.state` + `package_memories` into a single `package_persistence`
-- table with scope (user / end_user / shared) as a first-class dimension.
-- See docs/adr/ADR-011-checkpoint-unification.md.
--
-- DDL only — no back-fill from legacy stores. Legacy `runs.state` and
-- `package_memories` are removed in subsequent migrations; this file
-- creates the unified table and its indexes.

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
-- NULLs in the unique index are treated as DISTINCT by both Postgres and
-- PGlite by default, so two shared checkpoints (actor_id NULL) for the
-- same (package, app) would otherwise both be inserted. We can't use
-- `NULLS NOT DISTINCT` (Postgres 15+ only — PGlite rejects it), so we
-- coalesce `actor_id` to a sentinel string inside the index expression.
-- This makes the shared bucket compare-equal to itself across both
-- engines without changing the semantics of the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "pkp_checkpoint_unique"
  ON "package_persistence" ("package_id", "application_id", "actor_type", (COALESCE("actor_id", '__shared__')))
  WHERE "kind" = 'checkpoint';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pkp_lookup"
  ON "package_persistence" ("package_id", "application_id", "kind", "actor_type", "actor_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pkp_org"
  ON "package_persistence" ("org_id");
--> statement-breakpoint

-- Drop the legacy app-wide memory table. The unified `package_persistence`
-- store above is the single source of truth for both checkpoints and
-- memories with first-class actor scoping.
DROP TABLE IF EXISTS "package_memories";

