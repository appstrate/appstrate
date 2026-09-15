-- 0013 — one `org_models` row per (organization, credential, model), un-aliased.
--
-- Run BEFORE the drizzle batch that carries
-- `packages/db/drizzle/0062_org_models_unique_binding.sql`, when — and only
-- when — the rollout pre-flight in `README.md` counts a duplicate binding. Not
-- afterwards: letting `0062`'s `CREATE UNIQUE INDEX` raise 23505 rolls the
-- whole migration batch back. A duplicate needs two `POST /api/models` calls
-- for the same pair, so most deployments count zero and never run this.
--
-- ALIASED ROWS ARE OUT OF SCOPE, exactly as they are for the index: an alias is
-- a deliberate public identity over a backing model, so several of them — or
-- one beside the direct row — is not a duplicate. Every statement below is
-- confined to `aliased = false`.
--
-- KEEPS THE OLDEST row per binding — the one the organization has been running
-- against, and therefore the id that carries the most ledger history — and
-- REPOINTS every reference to the younger copies at it before deleting them.
--
-- `org_models.id` is named by four columns, none of them a foreign key (the
-- pointer columns also accept a SYSTEM model slug, which is not a row):
--
--   organizations.default_model_id   the org default pointer
--   space_packages.model_id          an agent's pinned model, per space
--   package_schedules.model_id_override   a schedule's per-fire override
--   llm_usage.model                  the preset the caller asked for
--
-- All four are `text` and `org_models.id` is `uuid`, so every comparison
-- against the temp table casts: PostgreSQL has no implicit `text = uuid`.
-- The assignments do not — uuid -> text is an accepted coercion.
--
-- The ledger is repointed too, and deliberately: `llm_usage.model` is what
-- per-model spend reporting groups by, so leaving the losers behind would keep
-- the split this whole change exists to end. It is not a billing rewrite —
-- the commercial module settles rows by serial id (`ee_billed_llm_usage`,
-- `ee_billing_cursor`) and never reads this column, so no row's billed state,
-- amount or cursor position moves. `real_model` (the upstream id the proxy
-- actually forwarded) is identical across the copies by construction and is
-- left untouched.
--
-- Idempotent: every write is keyed on "a younger sibling of the same binding
-- exists", which the DELETE then removes — a second run matches zero rows.
-- One transaction: a crash between the repoint and the delete would leave
-- pointers at rows that no longer exist.
--
-- Rows: UNMEASURED — the script prints the duplicate-binding count before and
-- after; the "after" count must be 0 for `0062` to succeed.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ═══ VERIFY (before) — bindings held by more than one row ═══
SELECT count(*) AS duplicate_bindings_before
FROM (
  SELECT org_id, credential_id, model_id
  FROM org_models
  WHERE aliased = false
  GROUP BY org_id, credential_id, model_id
  HAVING count(*) > 1
) d;

-- The survivor of each binding, and every loser mapped to it. Oldest wins,
-- `id` breaks a `created_at` tie so the choice is deterministic across reruns.
CREATE TEMP TABLE org_models_dedupe ON COMMIT DROP AS
SELECT
  m.id AS loser_id,
  first_value(m.id) OVER (
    PARTITION BY m.org_id, m.credential_id, m.model_id
    ORDER BY m.created_at, m.id
  ) AS keeper_id
FROM org_models m
WHERE m.aliased = false;

DELETE FROM org_models_dedupe WHERE loser_id = keeper_id;

SELECT count(*) AS rows_to_delete FROM org_models_dedupe;

-- ═══ REPOINT — every column naming a losing id ═══
UPDATE organizations o
SET default_model_id = d.keeper_id, updated_at = now()
FROM org_models_dedupe d
WHERE o.default_model_id = d.loser_id::text;

UPDATE space_packages p
SET model_id = d.keeper_id
FROM org_models_dedupe d
WHERE p.model_id = d.loser_id::text;

UPDATE package_schedules s
SET model_id_override = d.keeper_id
FROM org_models_dedupe d
WHERE s.model_id_override = d.loser_id::text;

UPDATE llm_usage u
SET model = d.keeper_id
FROM org_models_dedupe d
WHERE u.model = d.loser_id::text;

-- ═══ DELETE the losers ═══
DELETE FROM org_models m
USING org_models_dedupe d
WHERE m.id = d.loser_id;

-- ═══ VERIFY (after) — must print 0, and no reference may name a deleted id ═══
SELECT count(*) AS duplicate_bindings_after
FROM (
  SELECT org_id, credential_id, model_id
  FROM org_models
  WHERE aliased = false
  GROUP BY org_id, credential_id, model_id
  HAVING count(*) > 1
) d;

SELECT
  (SELECT count(*) FROM organizations o
     JOIN org_models_dedupe d ON o.default_model_id = d.loser_id::text) AS dangling_org_defaults,
  (SELECT count(*) FROM space_packages p
     JOIN org_models_dedupe d ON p.model_id = d.loser_id::text) AS dangling_agent_pins,
  (SELECT count(*) FROM package_schedules s
     JOIN org_models_dedupe d ON s.model_id_override = d.loser_id::text) AS dangling_schedule_overrides,
  (SELECT count(*) FROM llm_usage u
     JOIN org_models_dedupe d ON u.model = d.loser_id::text) AS dangling_ledger_rows;

COMMIT;
