-- Context-gauge denominator on `runs` (#1046): the model context window a run
-- was LAUNCHED with, plus the token count at which the runner auto-compacts.
--
-- HAND-EDITED (drizzle-kit emits neither `IF NOT EXISTS` nor `NOT VALID`), for
-- two reasons.
--
-- 1. RE-RUNNABLE, same discipline as 0020/0021/0023-0029: this database has a
--    history of hand-repaired migration state (a future-dated
--    `__drizzle_migrations` watermark that silently skips pending migrations),
--    and the recovery is to replay a migration. An unguarded `ADD COLUMN` /
--    `ADD CONSTRAINT` would then crash-loop the boot on `... already exists`.
--
-- 2. Both CHECKs go in `NOT VALID`, and are deliberately NOT validated here.
--    `runs` is the largest table in the schema and the boot migrator applies
--    every pending migration while the previous instance still serves, so the
--    two validation scans this would otherwise force are pure deploy-time
--    stall. They can only ever succeed: the columns they constrain are created
--    by the two statements above, so every pre-existing row holds NULL in both
--    and NULL passes a CHECK. `NOT VALID` skips exactly that vacuous scan and
--    nothing else — a `NOT VALID` CHECK is still enforced on every subsequent
--    INSERT and UPDATE, which is the entire guarantee the application relies on
--    (`deriveRunContextBudget` in apps/api/src/services/run-token-budget.ts
--    returns only pairs these constraints accept, or NULL).
--
--    Measured on a 1 000 000-row / 603 MB `runs` (PostgreSQL 16): validating
--    costs 309 ms + 105 ms of seq scan, `NOT VALID` costs 3.7 ms + 0.9 ms.
--
--    Note what is NOT the reason: `VALIDATE CONSTRAINT` taking only SHARE
--    UPDATE EXCLUSIVE buys nothing here. drizzle-orm's migrator wraps ALL
--    pending migrations in ONE `session.transaction` (pg-core/dialect.js
--    `migrate`), and the first `ADD COLUMN` below already takes ACCESS
--    EXCLUSIVE on `runs` and holds it to COMMIT — so a `VALIDATE CONSTRAINT`
--    split into this same file would run its scan under that lock anyway,
--    measured at 286 ms + 101 ms, i.e. the stall is not removed. Only skipping
--    the scan removes it. A later migration that validates would land in the
--    same transaction too whenever production's watermark predates this file
--    (the 0029 argument), so the split is not deferred work either — it is a
--    scan the schema proves unnecessary.
--
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "context_window" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "compaction_threshold" integer;--> statement-breakpoint
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, hence the plpgsql guards.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_context_window_positive'
      AND conrelid = 'public.runs'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_context_window_positive" CHECK (context_window > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- Written as an explicit `IS NULL OR (…)` rather than the bare comparison: a
-- bare `compaction_threshold < context_window` evaluates to NULL when the window
-- is NULL, and a CHECK accepts NULL — which would let an orphan threshold with
-- no window to divide by through. The two columns are meaningless apart.
-- The converse pairing IS legal and intended: a window with a NULL threshold.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'runs_compaction_threshold_within_window'
      AND conrelid = 'public.runs'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "runs" ADD CONSTRAINT "runs_compaction_threshold_within_window" CHECK (compaction_threshold IS NULL OR (context_window IS NOT NULL AND compaction_threshold > 0 AND compaction_threshold < context_window)) NOT VALID;
  END IF;
END $$;
