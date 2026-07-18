-- CRIT-07 completion: repair legacy `llm_usage` rows whose run attribution
-- crosses a tenant boundary, then VALIDATE the composite FK added NOT VALID
-- in 0020 so the invariant holds for EVERY row, not only new writes.
--
-- Repair semantics — `SET run_id = NULL`, deliberately NOT a DELETE and NOT
-- an `org_id` rewrite:
--   * The poisoned row records REAL spend by the *inserting* principal: its
--     `org_id` came from the authenticated principal at insert time and is
--     truthful. Deleting the row would erase real billing history.
--   * Its `run_id`, by contrast, points at a *foreign* org's run (the
--     caller-suppliable `X-Run-Id` proxy path, before the attribution guard).
--     Rewriting `org_id` to match the run would move the spend onto the
--     victim org's ledger — the opposite of a repair.
--   * Detaching the false run attribution (`run_id = NULL`) preserves the
--     payer's ledger and severs the cross-tenant link. `run_id` is nullable
--     and the composite FK is MATCH SIMPLE, so a NULL-run_id row passes it.
--
-- Locking, honestly: `VALIDATE CONSTRAINT` alone takes only SHARE UPDATE
-- EXCLUSIVE. But the boot migrator applies all pending migrations in ONE
-- transaction, so when 0020 and 0021 land together the ACCESS EXCLUSIVE lock
-- from 0020's `ADD CONSTRAINT` is still held across the scans below. On a
-- single-instance deployment that is a short boot pause; for a rolling deploy
-- against a large `llm_usage`, apply 0020 and 0021 in separate releases.
--
-- Re-runnable: the UPDATE is naturally idempotent (a detached row no longer
-- matches), and the VALIDATE is guarded so a replay — or a database where
-- 0020 was skipped by a corrupt `__drizzle_migrations` watermark — neither
-- crashes nor silently claims success.

-- Step 1: a `source='runner'` row can never be legitimately org-mismatched —
-- the platform writes both columns from the run row itself. The
-- `llm_usage_runner_has_run_id` check also forbids detaching it. So rather
-- than let the UPDATE below abort on an opaque check violation, fail loudly
-- with a message an operator can act on. This state means deeper corruption.
DO $$
DECLARE
  bad_runner_rows bigint;
BEGIN
  SELECT count(*) INTO bad_runner_rows
  FROM llm_usage u
  WHERE u.source = 'runner'
    AND u.run_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = u.run_id AND r.org_id = u.org_id);

  IF bad_runner_rows > 0 THEN
    RAISE EXCEPTION
      'llm_usage has % runner-source row(s) whose org_id does not match their run. Runner rows are platform-written and cannot legitimately drift; this indicates corruption. Investigate before deploying: SELECT * FROM llm_usage u WHERE u.source = ''runner'' AND u.run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = u.run_id AND r.org_id = u.org_id);',
      bad_runner_rows;
  END IF;
END $$;--> statement-breakpoint
-- Step 2: detach the false run attribution on the proxy-source rows.
UPDATE llm_usage SET run_id = NULL WHERE run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = llm_usage.run_id AND r.org_id = llm_usage.org_id);--> statement-breakpoint
-- Step 3: with the mismatched rows detached, validation cannot fail on legacy
-- data. Guarded so a replay is a no-op and a missing constraint (0020 skipped)
-- surfaces as a loud error rather than a silently unvalidated invariant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'llm_usage_run_id_org_id_fk'
  ) THEN
    RAISE EXCEPTION
      'llm_usage_run_id_org_id_fk is missing — migration 0020 did not apply. Check the __drizzle_migrations watermark before retrying.';
  END IF;

  IF NOT (
    SELECT convalidated FROM pg_constraint WHERE conname = 'llm_usage_run_id_org_id_fk'
  ) THEN
    ALTER TABLE "llm_usage" VALIDATE CONSTRAINT "llm_usage_run_id_org_id_fk";
  END IF;
END $$;
