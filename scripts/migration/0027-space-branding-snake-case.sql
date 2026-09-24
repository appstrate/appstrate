-- 0027 — rename the camelCase keys of `spaces.settings.branding` to snake_case
-- (#1545, CASING_CONVENTIONS 4g boundary): `logoUrl` → `logo_url`,
-- `primaryColor` → `primary_color`, `accentColor` → `accent_color`,
-- `supportEmail` → `support_email`, `fromName` → `from_name`. `name` and any
-- other key are untouched; values never change. When a row holds both
-- spellings, the one already snake_case wins. `spaces.settings` is returned
-- verbatim by the spaces routes, so the stored keys are wire keys.
-- No API writes `branding` (operators set it by hand). Run INSIDE the deploy
-- window (old app stopped, new one not started): the OIDC resolver's schema
-- is strict, so each build rejects the other spelling and renders the
-- platform default branding on the login, consent and email surfaces.
-- Cost: UPDATEs only the spaces still holding a camelCase branding key;
-- idempotent. Rows: UNMEASURED — rehearse on a restored dump first (README
-- requirement 4).

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  RAISE NOTICE 'before: % space(s) to rewrite',
    (SELECT count(*) FROM spaces
      WHERE jsonb_typeof(settings -> 'branding') = 'object'
        AND settings -> 'branding'
          ?| ARRAY['logoUrl', 'primaryColor', 'accentColor', 'supportEmail', 'fromName']);
END $$;

-- jsonb_object_agg keeps the LAST value of a duplicate key: renamed keys are
-- aggregated first, so an existing snake_case key overrides its camelCase twin.
UPDATE spaces SET settings = jsonb_set(settings, '{branding}', (
  SELECT jsonb_object_agg(
    CASE k
      WHEN 'logoUrl' THEN 'logo_url'
      WHEN 'primaryColor' THEN 'primary_color'
      WHEN 'accentColor' THEN 'accent_color'
      WHEN 'supportEmail' THEN 'support_email'
      WHEN 'fromName' THEN 'from_name'
      ELSE k END,
    v
    ORDER BY (k IN ('logoUrl', 'primaryColor', 'accentColor', 'supportEmail', 'fromName')) DESC)
  FROM jsonb_each(settings -> 'branding') AS e(k, v)))
WHERE jsonb_typeof(settings -> 'branding') = 'object'
  AND settings -> 'branding'
    ?| ARRAY['logoUrl', 'primaryColor', 'accentColor', 'supportEmail', 'fromName'];

-- ═══ After — re-derived from the table ══════════════════════════════════════

DO $$
DECLARE
  v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM spaces
    WHERE jsonb_typeof(settings -> 'branding') = 'object'
      AND settings -> 'branding'
        ?| ARRAY['logoUrl', 'primaryColor', 'accentColor', 'supportEmail', 'fromName'];
  RAISE NOTICE 'after: % space(s) still carry a camelCase branding key', v_left;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% space(s) still carry a camelCase branding key — aborting', v_left;
  END IF;
END $$;

COMMIT;
