-- Validation pass for the two money floors migration 0031 added `NOT VALID`.
-- Same role and same shape as migration 0030: the scan runs here, separately,
-- under SHARE UPDATE EXCLUSIVE (concurrent reads AND writes allowed), so an
-- operator can ship 0031 and 0032 in DIFFERENT releases against a large
-- `llm_usage` if the scan needs its own maintenance window. Shipped in the same
-- batch, the boot migrator applies both in one transaction — the split still
-- buys the escape hatch and keeps every full-table scan in one reviewable place.
--
-- Why neither validation can fail on production data: both columns have been
-- written exclusively through `recordLlmUsage` / the run finalizer, which clamp
-- at zero; `runs.cost` is otherwise NULL. A failure here therefore means a real
-- negative row exists and MUST be investigated (it is a billing error), not
-- worked around by dropping the constraint.
--
-- Constraints are located by FORM (table + contype 'c' + the exact set of
-- constrained columns) and their real name is read back from the catalog,
-- because `VALIDATE CONSTRAINT` needs a name and names DRIFT between databases
-- (`_check` from Postgres vs the Drizzle-supplied name) — that drift already
-- broke one production deploy here. A missing constraint is a loud failure, not
-- a silent skip: it means 0031 never applied, and continuing would leave the
-- invariant unenforced while claiming success. Already-validated constraints are
-- skipped, so a replay is a no-op.
DO $$
DECLARE
  spec  record;
  con   record;
  found integer;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- table                    constrained columns
      ('public.llm_usage'::text,  ARRAY['cost_usd']::text[]),
      ('public.runs',             ARRAY['cost'])
    ) AS t(tbl, cols)
  LOOP
    found := 0;
    FOR con IN
      SELECT c.conname, c.convalidated
      FROM pg_constraint c
      WHERE c.conrelid = spec.tbl::regclass
        AND c.contype = 'c'
        AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM pg_attribute a
             WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = spec.cols
    LOOP
      found := found + 1;
      IF NOT con.convalidated THEN
        EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', spec.tbl, con.conname);
      END IF;
    END LOOP;

    IF found = 0 THEN
      RAISE EXCEPTION
        'Expected check constraint on %(%) is missing: migration 0031 did not apply. Check the __drizzle_migrations watermark before retrying.',
        spec.tbl,
        array_to_string(spec.cols, ', ');
    END IF;
  END LOOP;
END $$;
