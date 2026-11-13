-- 0053 — remove `"output"` from every stored agent `runtime_tools`, in
-- `package_versions.manifest` and `packages.draft_manifest` (#2197).
--
-- ═══ WHY ═══
--
-- `output` is not a selectable runtime tool: the runner injects it whenever
-- the manifest declares a non-empty `output.schema`
-- (`readDeclaredOutputSchema`, packages/afps-shared/src/output-schema.ts), and
-- `SELECTABLE_RUNTIME_TOOLS` does not list it. A stored manifest that still
-- names it keeps running — the read path drops the id and reports it
-- (`retiredRuntimeTools: "drop"`) — but every save of such a draft is refused
-- on the author path (`retiredRuntimeTools: "reject"`), and every read reports
-- a drop. This file removes the id from the stored rows so both stop.
--
-- WHAT CHANGES FOR AN AGENT: nothing when it declares `output.schema` (it keeps
-- the `output` tool, injected from the schema). An agent that selected `output`
-- WITHOUT a schema loses the tool (decision A, issue #2197): it cannot
-- return a free-form result. Read the list of those agents BEFORE running this
-- file:
--
--   DATABASE_URL=<platform> bun scripts/migration/0052-report-output-runtime-tool.ts
--
-- (read-only; one transaction `READ ONLY`). It prints the counts per table and,
-- per affected agent, its org, its versions, its runs over 90 days and how many
-- of them stored a `result.output`.
--
-- Idempotent: the `WHERE` is exactly the condition the `UPDATE` removes, so a
-- second run reports `UPDATE 0` twice. The other ids keep the author's order.
-- When `output` was the only id, the `runtime_tools` key is REMOVED rather than
-- emptied, the bytes `dropRetiredRuntimeTools` and the editor write for an
-- empty selection. The `CASE` is also what keeps the `SET` safe: `jsonb_agg`
-- over an empty set returns NULL, and `jsonb_set(m, '{runtime_tools}', NULL)`
-- would null the whole manifest.
--
-- ═══ VERIFY ═══
--
-- Before — the rows this will rewrite. Run per table; record both numbers:
--   SELECT count(*) FROM package_versions
--   WHERE jsonb_typeof(manifest -> 'runtime_tools') = 'array'
--     AND manifest -> 'runtime_tools' @> '["output"]'::jsonb;
--   SELECT count(*) FROM packages
--   WHERE jsonb_typeof(draft_manifest -> 'runtime_tools') = 'array'
--     AND draft_manifest -> 'runtime_tools' @> '["output"]'::jsonb;
--
-- After — both MUST be 0. Re-running this file must then report UPDATE 0.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

UPDATE "package_versions" pv
SET "manifest" = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(pv."manifest" -> 'runtime_tools') AS t(id)
      WHERE t.id <> '"output"'::jsonb
    )
    THEN pv."manifest" - 'runtime_tools'
    ELSE jsonb_set(
      pv."manifest",
      '{runtime_tools}',
      (
        SELECT jsonb_agg(t.id ORDER BY t.ord)
        FROM jsonb_array_elements(pv."manifest" -> 'runtime_tools') WITH ORDINALITY AS t(id, ord)
        WHERE t.id <> '"output"'::jsonb
      )
    )
  END
WHERE jsonb_typeof(pv."manifest" -> 'runtime_tools') = 'array'
  AND pv."manifest" -> 'runtime_tools' @> '["output"]'::jsonb;

UPDATE "packages" p
SET "draft_manifest" = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p."draft_manifest" -> 'runtime_tools') AS t(id)
      WHERE t.id <> '"output"'::jsonb
    )
    THEN p."draft_manifest" - 'runtime_tools'
    ELSE jsonb_set(
      p."draft_manifest",
      '{runtime_tools}',
      (
        SELECT jsonb_agg(t.id ORDER BY t.ord)
        FROM jsonb_array_elements(p."draft_manifest" -> 'runtime_tools') WITH ORDINALITY AS t(id, ord)
        WHERE t.id <> '"output"'::jsonb
      )
    )
  END
WHERE jsonb_typeof(p."draft_manifest" -> 'runtime_tools') = 'array'
  AND p."draft_manifest" -> 'runtime_tools' @> '["output"]'::jsonb;

COMMIT;
