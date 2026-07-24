-- Validation pass for every constraint the preceding migrations added
-- `NOT VALID`. Same role as migration 0021 (which did this for the first
-- CRIT-07 composite FK), generalized: 0023 and 0027–0029 deliberately skip the
-- verification scan at ADD CONSTRAINT time so no migration ever holds a
-- write-blocking lock on `llm_usage` — the highest-volume table here — while it
-- reads the whole table. `NOT VALID` still enforces the constraint on every
-- INSERT and UPDATE from the moment it is added; what it does not give is the
-- guarantee that PRE-EXISTING rows comply. This migration buys that guarantee
-- back, under `SHARE UPDATE EXCLUSIVE` — a lock that permits concurrent reads
-- AND writes, unlike the `ACCESS EXCLUSIVE` / `SHARE ROW EXCLUSIVE` an
-- immediately-validating ADD CONSTRAINT takes.
--
-- Honest note on the boot migrator: it applies all pending migrations in ONE
-- transaction, so when this migration lands in the same batch as 0023–0029 the
-- locks those took are still held here and the whole batch is one lock window.
-- The split still matters — it is what lets an operator ship 0029 and 0030 in
-- SEPARATE releases against a large `llm_usage` (which is exactly the escape
-- hatch 0021's header documents), and it keeps every full-table scan of the
-- batch in one reviewable place.
--
-- Why none of these validations can fail on production data:
--   * `llm_usage` FKs to `runs` / `chat_sessions` (single-column): the same
--     references were already enforced before 0028 dropped and re-added them
--     with `SET NULL` semantics — every non-NULL value still points at a live row.
--   * `llm_usage_run_id_org_id_fk`: migration 0021 detached the mismatched
--     legacy rows and the constraint has enforced new writes ever since.
--   * `llm_usage_chat_session_id_org_id_fk` and `llm_usage_context_single`:
--     `chat_session_id` was introduced NULL-everywhere by 0023 and every write
--     since has been checked.
--   * `uploads_end_user_id_end_users_id_fk`: `end_user_id` was introduced
--     NULL-everywhere by 0027.
--   * the four `documents` / `document_links` composites: both tables are empty
--     in production (the subsystem has never been deployed), which is precisely
--     why 0029 is the free window to install them.
--
-- Constraints are located by FORM (referencing table + constraint type +
-- referenced table + the exact set of constrained columns) and their real name
-- is read back from the catalog, because `VALIDATE CONSTRAINT` needs a name and
-- names DRIFT between databases (`_fkey` from Postgres vs `_fk` from Drizzle) —
-- that drift already broke one production deploy here. A missing constraint is
-- a loud failure, not a silent skip: it means an earlier migration never
-- applied (the hand-repaired-watermark failure mode), and continuing would
-- leave the invariant unenforced while claiming success. Already-validated
-- constraints are skipped, so a replay is a no-op.
DO $$
DECLARE
  spec  record;
  con   record;
  found integer;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- table                       type        referenced table            constrained columns (sorted)
      ('public.llm_usage'::text,     'f'::"char", 'public.runs'::text,          ARRAY['run_id']::text[]),
      ('public.llm_usage',           'f',         'public.runs',                ARRAY['org_id','run_id']),
      ('public.llm_usage',           'f',         'public.chat_sessions',       ARRAY['chat_session_id']),
      ('public.llm_usage',           'f',         'public.chat_sessions',       ARRAY['chat_session_id','org_id']),
      ('public.llm_usage',           'c',         NULL,                         ARRAY['chat_session_id','run_id']),
      ('public.uploads',             'f',         'public.end_users',           ARRAY['end_user_id']),
      ('public.documents',           'f',         'public.runs',                ARRAY['org_id','run_id']),
      ('public.documents',           'f',         'public.chat_sessions',       ARRAY['chat_session_id','org_id']),
      ('public.document_links',      'f',         'public.documents',           ARRAY['document_id','org_id']),
      ('public.document_links',      'f',         'public.runs',                ARRAY['consumer_run_id','org_id'])
    ) AS t(tbl, ctype, reftbl, cols)
  LOOP
    found := 0;
    FOR con IN
      SELECT c.conname, c.convalidated
      FROM pg_constraint c
      WHERE c.conrelid = spec.tbl::regclass
        AND c.contype = spec.ctype
        AND (spec.reftbl IS NULL OR c.confrelid = spec.reftbl::regclass)
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
        'Expected % constraint on %(%) -> % is missing: an earlier migration did not apply. Check the __drizzle_migrations watermark before retrying.',
        CASE spec.ctype WHEN 'f' THEN 'foreign key' ELSE 'check' END,
        spec.tbl,
        array_to_string(spec.cols, ', '),
        coalesce(spec.reftbl, '(none)');
    END IF;
  END LOOP;
END $$;
