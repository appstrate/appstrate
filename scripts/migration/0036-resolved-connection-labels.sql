-- 0036 — give every run's connection snapshot its label and account (#1641).
--
-- `resolvedConnectionMapSchema` requires a string `label` and `accountId` on every
-- element of `runs.resolved_connections`; a pre-`0077` run may carry `label: null`, and
-- its reads 500. A missing label takes the connection's current one, else the element's
-- `accountId`, else its `connectionId`; a missing `accountId` takes the connection's,
-- else `''` (unknown: the connection is deleted). Order: `scripts/migration/README.md`.
-- Rows: UNMEASURED — record the rehearsal counts here. Idempotent; one transaction.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- REFUSE — a value `0032` has not made a set, or an element without a string
-- `connectionId` or with a source outside the cascade
DO $$
DECLARE
  unshaped bigint := (SELECT count(*) FROM runs r, jsonb_each(r.resolved_connections) AS e(k, v)
                       WHERE jsonb_typeof(v) <> 'array');
  no_connection_id bigint := (
    SELECT count(*) FROM runs r, jsonb_each(r.resolved_connections) AS e(k, v),
           jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE '[]' END) AS el
    WHERE jsonb_typeof(el->'connectionId') IS DISTINCT FROM 'string');
  unknown_source bigint := (
    SELECT count(*) FROM runs r, jsonb_each(r.resolved_connections) AS e(k, v),
           jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE '[]' END) AS el
    WHERE el->>'source' IS NULL OR el->>'source' NOT IN ('admin_pin', 'org_default_enforced',
      'run_override', 'schedule_override', 'member_pin', 'org_default', 'fallback_auto'));
BEGIN
  IF unshaped > 0 THEN
    RAISE EXCEPTION '0036: % runs.resolved_connections value(s) are not a set — run 0032 first. Nothing was written.', unshaped;
  END IF;
  IF no_connection_id > 0 THEN
    RAISE EXCEPTION '0036: % snapshot element(s) carry no string `connectionId`. Nothing was written; inspect them.', no_connection_id;
  END IF;
  IF unknown_source > 0 THEN
    RAISE EXCEPTION '0036: % snapshot element(s) name no cascade layer in `source`. Nothing was written; inspect them.', unknown_source;
  END IF;
END $$;

CREATE TEMP TABLE _0036_unlabelled ON COMMIT DROP AS
SELECT r.id FROM runs r
WHERE EXISTS (
  SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v), jsonb_array_elements(v) AS el
  WHERE jsonb_typeof(el->'label') IS DISTINCT FROM 'string'
     OR jsonb_typeof(el->'accountId') IS DISTINCT FROM 'string');

-- ═══ VERIFY (before) ═══
SELECT count(*) AS runs_before FROM _0036_unlabelled;

UPDATE runs r
SET resolved_connections = (
  SELECT jsonb_object_agg(e.k, coalesce((
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(a.el->'label') = 'string' AND jsonb_typeof(a.el->'accountId') = 'string'
          THEN a.el
        ELSE a.el || jsonb_build_object(
          'label', coalesce(
            CASE WHEN jsonb_typeof(a.el->'label') = 'string' THEN a.el->>'label' END,
            c.label,
            CASE WHEN jsonb_typeof(a.el->'accountId') = 'string' THEN a.el->>'accountId' END,
            a.el->>'connectionId'),
          'accountId', coalesce(
            CASE WHEN jsonb_typeof(a.el->'accountId') = 'string' THEN a.el->>'accountId' END,
            c.account_id,
            ''))
      END ORDER BY a.ord)
    FROM jsonb_array_elements(e.v) WITH ORDINALITY AS a(el, ord)
    LEFT JOIN integration_connections c ON c.id::text = a.el->>'connectionId'
  ), '[]'::jsonb))
  FROM jsonb_each(r.resolved_connections) AS e(k, v)
)
FROM _0036_unlabelled u
WHERE r.id = u.id;

-- ═══ VERIFY (after) — raises, rolling everything back, if any element is still short ═══
DO $$
DECLARE
  still_short bigint := (
    SELECT count(*) FROM runs r, jsonb_each(r.resolved_connections) AS e(k, v),
           jsonb_array_elements(v) AS el
    WHERE jsonb_typeof(el->'label') IS DISTINCT FROM 'string'
       OR jsonb_typeof(el->'accountId') IS DISTINCT FROM 'string');
BEGIN
  IF still_short > 0 THEN
    RAISE EXCEPTION '0036: % snapshot element(s) still lack a string label or accountId. Nothing was written; inspect them.', still_short;
  END IF;
END $$;

SELECT count(*) AS runs_after FROM runs r
WHERE EXISTS (
  SELECT 1 FROM jsonb_each(r.resolved_connections) AS e(k, v), jsonb_array_elements(v) AS el
  WHERE jsonb_typeof(el->'label') IS DISTINCT FROM 'string'
     OR jsonb_typeof(el->'accountId') IS DISTINCT FROM 'string');

COMMIT;
