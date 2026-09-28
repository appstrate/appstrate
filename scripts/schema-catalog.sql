-- Schema catalog fingerprint — one sorted line per column, index, constraint and
-- enum of the platform's `public` schema. Read-only: catalog queries only.
--
-- What it is for (#1507): a database created before a migration squash can sit
-- at the full journal and still not be the schema the chain builds — production
-- carried 60 `timestamp` columns, two retired enum labels, 19 auto-named
-- constraints and 6 missing ones that way, invisible to everything but a
-- catalog diff. `packages/db/schema-catalog.txt` is this query's output on a
-- database built by `bun packages/db/src/migrate.ts`; comparing any other
-- database's output against it is that diff.
--
--   CI  — `bun run verify:schema-catalog` on a freshly migrated database keeps
--         the committed fingerprint equal to what the chain builds.
--   ops — the same query on production (runbook, Phase 2a) says whether
--         production is that schema:
--           docker exec -i <pg> psql -U appstrate -d appstrate -tA -f - \
--             < scripts/schema-catalog.sql | diff packages/db/schema-catalog.txt -
--
-- Deliberately left out:
--   * `ee_*` tables — `@appstrate/module-ee` migrates them under its own
--     journal (`drizzle.ee_migrations`) at init, not through `migrate.ts`;
--   * triggers and functions — the platform installs its NOTIFY triggers at
--     boot, so a migrate-only database has none;
--   * column order — a column added later lands last, and nothing reads the
--     order, so it would only report noise.
-- Formatting comes from Postgres itself (`format_type`, `pg_get_expr`,
-- `pg_get_indexdef`, `pg_get_constraintdef`), so both sides must run the same
-- major version — Postgres 16, like production.
SELECT line FROM (
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS line
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    AND c.relname NOT LIKE 'ee\_%'
  UNION ALL
  SELECT 'index ' || pg_get_indexdef(i.indexrelid)
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname NOT LIKE 'ee\_%'
  UNION ALL
  -- `pg_get_constraintdef` appends `NOT VALID` to an unvalidated constraint.
  SELECT 'constraint ' || c.relname || ' ' || con.conname || ' ' || pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname NOT LIKE 'ee\_%'
  UNION ALL
  SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
  GROUP BY t.typname
) catalog
ORDER BY line COLLATE "C";
