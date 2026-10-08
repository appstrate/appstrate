-- 0036 — no end user's connection stays shared with the organization, nor named by an admin pin
-- or an org default (#1775). The release refuses both (`assertConnectionShareable`,
-- `validatePinTargets`), and its drizzle `0080` adds the CHECK
-- `integration_connections_end_user_not_shared`, whose first statement refuses the batch while
-- this file has not run.
--
-- Run BEFORE deploying the release that carries `0080`, with the app container stopped
-- (`docker stop`, not a Coolify stop — that takes Postgres down and prunes the images): the
-- running image still lets an end user share, so a share landing between this file and the deploy
-- would make `0080` refuse the boot. Stop → `pg_dump` → this file → deploy → reopen:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migration/0036-unshare-end-user-connections.sql
--
-- Pre-flight, read-only, on production or a restored dump first — what each step would touch:
--
--   SELECT
--     (SELECT count(*) FROM integration_connections
--       WHERE end_user_id IS NOT NULL AND shared_with_org)                      AS shared,
--     (SELECT count(*) FROM integration_pins p
--       WHERE p.user_id IS NULL AND EXISTS (SELECT 1 FROM integration_connections c
--         WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL))     AS admin_pins,
--     (SELECT count(*) FROM integration_org_defaults d
--       WHERE EXISTS (SELECT 1 FROM integration_connections c
--         WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL))     AS org_defaults;
--
-- Expected: 0 / 0 / 0 — no known integrator shares an end user's connection. Rows: UNMEASURED,
-- rehearse on a restored dump first (README requirement 4).
--
-- Three steps in ONE transaction, in this order; each "after" count must read 0:
--
-- 1. ADMIN PINS (`user_id IS NULL`) and 2. ORG DEFAULTS — every end user's connection id leaves
--    the set, the rest kept in their binding order. A row the removal would empty is deleted
--    first: `cardinality BETWEEN 1 AND 10` refuses an empty set, and a deleted pin or default is
--    what an admin's `DELETE` leaves — the cascade falls through to the next layer. Before the
--    unshare, because these are exactly the references that refuse an unshare
--    (`assertConnectionsUnpinned`). Matched on the owner alone, shared or not, since the release
--    refuses any end user's connection there.
-- 3. UNSHARE — `shared_with_org = false` on every end user's connection still shared.
--
-- Steps 1-3 are what an admin does by hand today: clear the pin or default, then unshare. A
-- member pin or a schedule override naming such a connection is left alone, as that unshare
-- leaves it: it fails loudly (`pinned_connection_unavailable` / `override_connection_unavailable`)
-- until its owner picks again, and is never shrunk to its survivors. The counts below report
-- them (`*_kept`); an end user's own schedules naming its own connection are not counted.
--
-- No audit row: no script here writes `audit_events`. The listing below names every pin and
-- default rewritten or deleted, with its set before.
--
-- Idempotent: every WHERE is the condition its write removes, so a second run matches nothing.
-- Rollback: none (a removed id is gone); restore the pre-run `pg_dump`.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ═══ Before ═══

SELECT
  (SELECT count(*) FROM integration_connections
    WHERE end_user_id IS NOT NULL AND shared_with_org)                        AS end_user_shared_before,
  (SELECT count(*) FROM integration_pins p
    WHERE p.user_id IS NULL AND EXISTS (SELECT 1 FROM integration_connections c
      WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL))       AS admin_pins_before,
  (SELECT count(*) FROM integration_pins p
    WHERE p.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM unnest(p.connection_ids) AS u(id)
      WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL)))
                                                                                AS admin_pins_emptied_before,
  (SELECT count(*) FROM integration_org_defaults d
    WHERE EXISTS (SELECT 1 FROM integration_connections c
      WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL))       AS org_defaults_before,
  (SELECT count(*) FROM integration_org_defaults d
    WHERE NOT EXISTS (SELECT 1 FROM unnest(d.connection_ids) AS u(id)
      WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL)))
                                                                                AS org_defaults_emptied_before,
  (SELECT count(*) FROM integration_pins p
    WHERE p.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM integration_connections c
      WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL))       AS member_pins_kept,
  (SELECT count(*) FROM package_schedules s
    WHERE s.connection_overrides IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_each(s.connection_overrides) AS e(k, v)
      CROSS JOIN LATERAL jsonb_array_elements_text(e.v) AS o(id)
      JOIN integration_connections c ON c.id::text = o.id
      WHERE c.end_user_id IS NOT NULL
        AND c.end_user_id IS DISTINCT FROM s.end_user_id))                      AS schedules_kept;

-- The pins and defaults steps 1 and 2 rewrite or delete, with their set before.
SELECT 'admin_pin' AS kind, p.space_id, p.package_id AS agent_id, p.integration_package_id,
       p.connection_ids::text AS connection_ids_before
FROM integration_pins p
WHERE p.user_id IS NULL AND EXISTS (SELECT 1 FROM integration_connections c
  WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL)
UNION ALL
SELECT 'org_default', d.space_id, NULL, d.integration_package_id, d.connection_ids::text
FROM integration_org_defaults d
WHERE EXISTS (SELECT 1 FROM integration_connections c
  WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL)
ORDER BY 1, 2, 3, 4;

-- ═══ 1. ADMIN PINS ═══

DELETE FROM integration_pins p
WHERE p.user_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM unnest(p.connection_ids) AS u(id)
    WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL));

UPDATE integration_pins p
SET connection_ids = ARRAY(
      SELECT u.id FROM unnest(p.connection_ids) WITH ORDINALITY AS u(id, n)
      WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL)
      ORDER BY u.n),
    updated_at = now()
WHERE p.user_id IS NULL
  AND EXISTS (SELECT 1 FROM integration_connections c
    WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL);

-- ═══ 2. ORG DEFAULTS ═══

DELETE FROM integration_org_defaults d
WHERE NOT EXISTS (SELECT 1 FROM unnest(d.connection_ids) AS u(id)
  WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL));

UPDATE integration_org_defaults d
SET connection_ids = ARRAY(
      SELECT u.id FROM unnest(d.connection_ids) WITH ORDINALITY AS u(id, n)
      WHERE u.id NOT IN (SELECT id FROM integration_connections WHERE end_user_id IS NOT NULL)
      ORDER BY u.n),
    updated_at = now()
WHERE EXISTS (SELECT 1 FROM integration_connections c
  WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL);

-- ═══ 3. UNSHARE ═══

UPDATE integration_connections
SET shared_with_org = false, updated_at = now()
WHERE end_user_id IS NOT NULL AND shared_with_org;

-- ═══ After — re-derived from the tables ═══

SELECT
  (SELECT count(*) FROM integration_connections
    WHERE end_user_id IS NOT NULL AND shared_with_org)                        AS end_user_shared_after,
  (SELECT count(*) FROM integration_pins p
    WHERE p.user_id IS NULL AND EXISTS (SELECT 1 FROM integration_connections c
      WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL))       AS admin_pins_after,
  (SELECT count(*) FROM integration_org_defaults d
    WHERE EXISTS (SELECT 1 FROM integration_connections c
      WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL))       AS org_defaults_after;

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT (SELECT count(*) FROM integration_connections
           WHERE end_user_id IS NOT NULL AND shared_with_org)
       + (SELECT count(*) FROM integration_pins p
           WHERE p.user_id IS NULL AND EXISTS (SELECT 1 FROM integration_connections c
             WHERE c.id = ANY (p.connection_ids) AND c.end_user_id IS NOT NULL))
       + (SELECT count(*) FROM integration_org_defaults d
           WHERE EXISTS (SELECT 1 FROM integration_connections c
             WHERE c.id = ANY (d.connection_ids) AND c.end_user_id IS NOT NULL))
    INTO v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '0036: % row(s) still share or name an end user''s connection — aborting', v_left;
  END IF;
END $$;

COMMIT;
