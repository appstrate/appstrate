-- 0053 — move every stored agent manifest from `runtime_tools` to the
-- `@appstrate/platform` integration, in `package_versions.manifest` and
-- `packages.draft_manifest`, in one pass (#2197, #2199).
--
-- ═══ WHY ═══
--
-- `log`, `note`, `pin`, `recall_memory` and `run_history` are tools of the
-- `@appstrate/platform` system integration: an agent receives them by
-- declaring it, and `integrations_configuration.<id>.tools` restricts them.
-- `output` is injected from `output.schema`, `publish_file` is a harness tool,
-- and nothing reads `runtime_tools`. A run of a published version reads the
-- jsonb `package_versions.manifest` (`resolveAgentRunVersion` and the registry
-- resolver take the catalog row's manifest; the archive supplies only the
-- prompt), so rewriting the rows is enough: no archive is rewritten and no
-- corrective version is published.
--
-- For each agent manifest that carries `runtime_tools` or does not declare
-- `@appstrate/platform`:
--
--   1. `dependencies.integrations."@appstrate/platform"` = `^1.0.0` (an
--      existing range is kept);
--   2. `integrations_configuration."@appstrate/platform".tools` =
--      (`runtime_tools` ∩ {log, note, pin}) ∪ {recall_memory, run_history}, in
--      catalog order — `recall_memory` and `run_history` were served to every
--      agent; keys already in the entry win;
--   3. `runtime_tools` is removed.
--
-- WHAT CHANGES FOR AN AGENT: it keeps the tools it had, under the names
-- `appstrate_platform__<tool>`. An agent that selected `output` WITHOUT an
-- `output.schema` has no `output` tool (decision A, issue #2197). Read the
-- report BEFORE running this file:
--
--   DATABASE_URL=<platform> bun scripts/migration/0052-report-runtime-tools.ts
--
-- (read-only; one transaction `READ ONLY`). It prints the rows this file
-- rewrites and the agents that lose `output`.
--
-- A manifest whose `dependencies`, `dependencies.integrations` or
-- `integrations_configuration` is present but not an object is left
-- untouched; the report counts it.
--
-- Idempotent: a rewritten manifest has no `runtime_tools` and declares
-- `@appstrate/platform`, so a second run reports `UPDATE 0` twice.
--
-- ═══ VERIFY ═══
--
-- Before — the rows this will rewrite (`to_rewrite` in the report), and after:
--   SELECT count(*) FROM package_versions
--   WHERE manifest ->> 'type' = 'agent'
--     AND (manifest -> 'runtime_tools' IS NOT NULL
--          OR manifest -> 'dependencies' -> 'integrations' -> '@appstrate/platform' IS NULL);
--   SELECT count(*) FROM packages
--   WHERE draft_manifest ->> 'type' = 'agent'
--     AND (draft_manifest -> 'runtime_tools' IS NOT NULL
--          OR draft_manifest -> 'dependencies' -> 'integrations' -> '@appstrate/platform' IS NULL);
--
-- After — both equal the report's `malformed` count (0 on a clean
-- database). Re-running this file must then report UPDATE 0.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE OR REPLACE FUNCTION pg_temp.needs_platform(m jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    m ->> 'type' = 'agent'
    AND jsonb_typeof(COALESCE(m -> 'dependencies', '{}'::jsonb)) = 'object'
    AND jsonb_typeof(COALESCE(m -> 'dependencies' -> 'integrations', '{}'::jsonb)) = 'object'
    AND jsonb_typeof(COALESCE(m -> 'integrations_configuration', '{}'::jsonb)) = 'object'
    AND (m -> 'runtime_tools' IS NOT NULL
         OR m -> 'dependencies' -> 'integrations' -> '@appstrate/platform' IS NULL),
    false)
$$;

CREATE OR REPLACE FUNCTION pg_temp.with_platform(m jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT (m - 'runtime_tools') || jsonb_build_object(
    'dependencies',
    COALESCE(m -> 'dependencies', '{}'::jsonb) || jsonb_build_object(
      'integrations',
      COALESCE(m -> 'dependencies' -> 'integrations', '{}'::jsonb) || jsonb_build_object(
        '@appstrate/platform',
        COALESCE(m -> 'dependencies' -> 'integrations' -> '@appstrate/platform', '"^1.0.0"'::jsonb))),
    'integrations_configuration',
    COALESCE(m -> 'integrations_configuration', '{}'::jsonb) || jsonb_build_object(
      '@appstrate/platform',
      jsonb_build_object('tools', (
        SELECT jsonb_agg(c.tool ORDER BY c.ord)
        FROM unnest(ARRAY['log', 'note', 'pin', 'recall_memory', 'run_history'])
          WITH ORDINALITY AS c(tool, ord)
        WHERE c.tool IN ('recall_memory', 'run_history')
           OR (jsonb_typeof(m -> 'runtime_tools') = 'array'
               AND m -> 'runtime_tools' @> jsonb_build_array(c.tool))))
      || COALESCE(m -> 'integrations_configuration' -> '@appstrate/platform', '{}'::jsonb)))
$$;

UPDATE "package_versions"
SET "manifest" = pg_temp.with_platform("manifest")
WHERE pg_temp.needs_platform("manifest");

UPDATE "packages"
SET "draft_manifest" = pg_temp.with_platform("draft_manifest")
WHERE pg_temp.needs_platform("draft_manifest");

COMMIT;
