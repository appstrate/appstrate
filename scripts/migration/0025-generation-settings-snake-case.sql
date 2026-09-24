-- 0025 — rename the `reasoningLevel` key to `reasoning_level` in every stored
-- `ModelGenerationSettings` object (#1545 D1): `runs.generation_config`,
-- `runs.generation_config_override`, `space_packages.generation_config` and
-- `package_schedules.generation_config_override`. `temperature` is unchanged.
-- A row holding both spellings keeps its existing `reasoning_level` (the
-- right operand of `||` wins) and loses `reasoningLevel`.
-- Run INSIDE the deploy window (old app stopped, new one not started): each
-- build reads only its own spelling, so a row in the other one loses its
-- reasoning level. Cost: UPDATEs only the rows still holding `reasoningLevel`;
-- idempotent. Rows: UNMEASURED — rehearse on a restored dump first (README
-- requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % run config(s), % run override(s), % space package(s), % schedule(s) to rewrite',
    (SELECT count(*) FROM runs WHERE generation_config ? 'reasoningLevel'),
    (SELECT count(*) FROM runs WHERE generation_config_override ? 'reasoningLevel'),
    (SELECT count(*) FROM space_packages WHERE generation_config ? 'reasoningLevel'),
    (SELECT count(*) FROM package_schedules WHERE generation_config_override ? 'reasoningLevel');
END $$;

UPDATE runs SET generation_config = jsonb_build_object('reasoning_level', generation_config -> 'reasoningLevel')
    || (generation_config - 'reasoningLevel')
WHERE generation_config ? 'reasoningLevel';

UPDATE runs SET generation_config_override = jsonb_build_object('reasoning_level', generation_config_override -> 'reasoningLevel')
    || (generation_config_override - 'reasoningLevel')
WHERE generation_config_override ? 'reasoningLevel';

UPDATE space_packages SET generation_config = jsonb_build_object('reasoning_level', generation_config -> 'reasoningLevel')
    || (generation_config - 'reasoningLevel')
WHERE generation_config ? 'reasoningLevel';

UPDATE package_schedules SET generation_config_override = jsonb_build_object('reasoning_level', generation_config_override -> 'reasoningLevel')
    || (generation_config_override - 'reasoningLevel')
WHERE generation_config_override ? 'reasoningLevel';

-- ═══ After — re-derived from the tables ═════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM runs
      WHERE generation_config ? 'reasoningLevel' OR generation_config_override ? 'reasoningLevel')
    + (SELECT count(*) FROM space_packages WHERE generation_config ? 'reasoningLevel')
    + (SELECT count(*) FROM package_schedules WHERE generation_config_override ? 'reasoningLevel')
  INTO v_left;
  RAISE NOTICE 'after: % row(s) still carry a reasoningLevel key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% row(s) still carry a reasoningLevel key — aborting', v_left;
  END IF;
END $$;

COMMIT;
