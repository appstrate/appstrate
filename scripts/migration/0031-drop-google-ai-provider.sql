-- 0031 — delete the `google-ai` model provider's credentials and every org
-- model bound to one (#1568).
--
-- The release that removes the provider registers no `google-ai` entry and no
-- `google-generative-ai` shape: a credential still naming it resolves nowhere,
-- and `loadModel` refuses a model bound to one (409
-- `model_provider_unregistered`) rather than falling through to another model.
-- Run INSIDE the deploy window, platform stopped, before the new image boots
-- (the scheduler reloads a schedule's model override from the table only at
-- boot). Rows: 0 — rehearsed 2026-09-25 on a restored production dump
-- (PostgreSQL 16.15, drizzle 0068 + 0069–0073): every "before" count 0 (no
-- `google-ai` credential in production), COMMIT in 214 ms, a rerun a no-op.
--
-- `org_models.id` is named by three pointer columns, none of them a foreign
-- key (they also accept a SYSTEM model slug) — all set to NULL, so nothing is
-- left naming a deleted row:
--
--   organizations.default_model_id        → the system default
--   space_packages.model_id               → the org default
--   package_schedules.model_id_override   → the agent's model
--
-- Left alone, as history: `runs.model_id` and `llm_usage.model` (the ledger).
-- Two FKs are `ON DELETE SET NULL`. `runs.model_credential_id`: the runs that
-- ran on a deleted credential lose that attribution — counted below as
-- `runs_losing_credential_id`. `model_provider_pairings.credential_id`: a
-- pairing only ever names an OAuth credential, so no `google-ai` one moves.
-- `org_models.credential_id` is `ON DELETE RESTRICT`, which is why the models
-- go before the credentials.
--
-- Idempotent: every WHERE is "provider_id = 'google-ai'" or a pointer to a
-- model bound to such a credential — a second run matches zero rows. One
-- transaction: a failure leaves nothing half-done.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE doomed_google_ai_models ON COMMIT DROP AS
SELECT m.id::text AS id
FROM org_models m
JOIN model_provider_credentials c ON c.id = m.credential_id
WHERE c.provider_id = 'google-ai';

-- ═══ VERIFY (before) ═══
SELECT
  (SELECT count(*) FROM model_provider_credentials
     WHERE provider_id = 'google-ai') AS credentials_before,
  (SELECT count(*) FROM doomed_google_ai_models) AS org_models_before,
  (SELECT count(*) FROM organizations o
     JOIN doomed_google_ai_models d ON o.default_model_id = d.id) AS org_defaults_before,
  (SELECT count(*) FROM space_packages p
     JOIN doomed_google_ai_models d ON p.model_id = d.id) AS space_pins_before,
  (SELECT count(*) FROM package_schedules s
     JOIN doomed_google_ai_models d ON s.model_id_override = d.id) AS schedule_overrides_before,
  (SELECT count(*) FROM runs r
     JOIN model_provider_credentials c ON c.id = r.model_credential_id
     WHERE c.provider_id = 'google-ai') AS runs_losing_credential_id;

-- ═══ RECORD — every row deleted or re-pointed below, with what it held.
-- Nothing else keeps it: save this psql output with the deploy notes. ═══
SELECT c.org_id, c.id AS credential_id, c.label AS credential_label
FROM model_provider_credentials c
WHERE c.provider_id = 'google-ai'
ORDER BY c.org_id, c.id;

SELECT m.org_id, m.id AS org_model_id, m.label, m.model_id AS upstream_model_id,
       m.credential_id
FROM org_models m
JOIN doomed_google_ai_models d ON m.id::text = d.id
ORDER BY m.org_id, m.id;

SELECT o.id AS org_id, o.default_model_id AS nulled_model_id
FROM organizations o
JOIN doomed_google_ai_models d ON o.default_model_id = d.id
ORDER BY o.id;

SELECT p.space_id, p.package_id, p.model_id AS nulled_model_id
FROM space_packages p
JOIN doomed_google_ai_models d ON p.model_id = d.id
ORDER BY p.space_id, p.package_id;

SELECT s.id AS schedule_id, s.org_id, s.model_id_override AS nulled_model_id
FROM package_schedules s
JOIN doomed_google_ai_models d ON s.model_id_override = d.id
ORDER BY s.id;

-- ═══ POINTERS — every column naming a doomed model ═══
UPDATE organizations o
SET default_model_id = NULL, updated_at = now()
FROM doomed_google_ai_models d
WHERE o.default_model_id = d.id;

UPDATE space_packages p
SET model_id = NULL, updated_at = now()
FROM doomed_google_ai_models d
WHERE p.model_id = d.id;

UPDATE package_schedules s
SET model_id_override = NULL, updated_at = now()
FROM doomed_google_ai_models d
WHERE s.model_id_override = d.id;

-- ═══ DELETE — the models, then the credentials they held ═══
DELETE FROM org_models m
USING doomed_google_ai_models d
WHERE m.id::text = d.id;

DELETE FROM model_provider_credentials
WHERE provider_id = 'google-ai';

-- ═══ VERIFY (after) — re-derived from the tables; aborts unless all are 0 ═══
DO $$
DECLARE
  v_credentials bigint;
  v_models bigint;
  v_pointers bigint;
BEGIN
  SELECT count(*) INTO v_credentials FROM model_provider_credentials
  WHERE provider_id = 'google-ai';
  SELECT count(*) INTO v_models FROM org_models m
  JOIN doomed_google_ai_models d ON m.id::text = d.id;
  SELECT
    (SELECT count(*) FROM organizations o
       JOIN doomed_google_ai_models d ON o.default_model_id = d.id)
    + (SELECT count(*) FROM space_packages p
       JOIN doomed_google_ai_models d ON p.model_id = d.id)
    + (SELECT count(*) FROM package_schedules s
       JOIN doomed_google_ai_models d ON s.model_id_override = d.id)
  INTO v_pointers;
  RAISE NOTICE 'after: % credential(s), % org model(s), % pointer(s) left',
    v_credentials, v_models, v_pointers;
  IF v_credentials + v_models + v_pointers > 0 THEN
    RAISE EXCEPTION 'google-ai rows still present — aborting';
  END IF;
END $$;

COMMIT;
