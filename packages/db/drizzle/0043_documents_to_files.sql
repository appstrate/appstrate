-- Rename the `document` concept to `file` (issue #1177, phase 2).
--
-- "Document" is a false friend: the entity is ANY file an agent produced —
-- Markdown, HTML, source code, a PDF, an image — but the word promises a Word
-- or PDF document to every reader, the model included. The concept is renamed
-- from the schema up; this migration is the storage half of it.
--
-- RENAME, NEVER DROP-AND-RECREATE. `documents` holds live production rows,
-- `organizations.documents_bytes_*` holds a live running total, and every FK
-- pointing at them must survive. `ALTER … RENAME` is a catalog-only operation:
-- no table rewrite, no data movement, no window where a constraint is absent.
--
-- What is deliberately NOT renamed:
--   * the row id prefix `doc_` — already in every row and in every storage key;
--   * the `documents/` storage-key prefix and the `documents` bucket literal —
--     live object storage; renaming them would orphan every stored file;
--   * the enum VALUES (`user_upload` / `agent_output`) — only the type name
--     changes.
--
-- Two traps this migration is written against:
--
--   1. **Postgres does not always name a constraint the way Drizzle does.**
--      This repo has already been bitten by `_fkey` vs `_fk` drift (a table
--      created outside the migration chain gets Postgres's default names). So
--      the constraint and index passes below do NOT enumerate names: they read
--      the catalog for whatever is actually attached to the renamed tables and
--      rewrite `document` → `file` inside each name. A name that is not there
--      cannot fail, and a name that drifted is carried forward with its drift
--      intact rather than being invented.
--
--   2. **Renaming a table auto-renames nothing else.** Its indexes, its
--      constraints and its sequences keep their old names. Hence the explicit
--      passes below. (Renaming a constraint DOES rename its backing index, so
--      the constraint pass runs first and the index pass then sees only the
--      free-standing indexes.)
--
-- Every step is guarded so a partially-applied environment converges.

-- Step 1: the enum TYPE. Values are untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'document_purpose')
     AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'file_purpose') THEN
    ALTER TYPE "public"."document_purpose" RENAME TO "file_purpose";
  END IF;
END $$;--> statement-breakpoint

-- Step 2: the two tables.
DO $$
BEGIN
  IF to_regclass('public.documents') IS NOT NULL AND to_regclass('public.files') IS NULL THEN
    ALTER TABLE "documents" RENAME TO "files";
  END IF;
  IF to_regclass('public.document_links') IS NOT NULL
     AND to_regclass('public.file_links') IS NULL THEN
    ALTER TABLE "document_links" RENAME TO "file_links";
  END IF;
END $$;--> statement-breakpoint

-- Step 3: columns. `file_links.document_id` is the only column carrying the old
-- word inside the two renamed tables; `organizations` carries the two byte
-- counters.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'file_links' AND column_name = 'document_id'
  ) THEN
    ALTER TABLE "file_links" RENAME COLUMN "document_id" TO "file_id";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name = 'documents_bytes_used'
  ) THEN
    ALTER TABLE "organizations" RENAME COLUMN "documents_bytes_used" TO "files_bytes_used";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name = 'documents_bytes_limit'
  ) THEN
    ALTER TABLE "organizations" RENAME COLUMN "documents_bytes_limit" TO "files_bytes_limit";
  END IF;
END $$;--> statement-breakpoint

-- Step 3b: constraints Postgres attached to the two renamed `organizations`
-- columns. On PG17+ a NOT NULL constraint is a named catalog object
-- (`organizations_documents_bytes_used_not_null`) and a column rename does not
-- carry the name along; on PG16 — what production runs — nothing matches and
-- this pass is a no-op. Catalog-driven for the same reason as step 4.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'organizations'
      AND c.conname LIKE '%documents_bytes%'
  LOOP
    EXECUTE format(
      'ALTER TABLE "public"."organizations" RENAME CONSTRAINT %I TO %I',
      r.conname, replace(r.conname, 'documents_bytes', 'files_bytes')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- Step 4: constraints attached to the two renamed tables — primary keys, the
-- single-column and composite foreign keys, and the single-container CHECK.
-- Catalog-driven (see trap 1): whatever name is actually there is rewritten,
-- and `replace()` maps every expected name onto exactly the name the Drizzle
-- schema now declares —
--   documents_run_id_org_id_fk            -> files_run_id_org_id_fk
--   documents_pkey                        -> files_pkey
--   chk_documents_single_container        -> chk_files_single_container
--   document_links_document_id_documents_id_fk -> file_links_file_id_files_id_fk
--   document_links_document_id_consumer_run_id_pk
--                                         -> file_links_file_id_consumer_run_id_pk
-- Renaming a constraint also renames its backing index, so the unique/PK
-- indexes are handled here and skipped by step 5.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname,
           quote_ident(n.nspname) || '.' || quote_ident(t.relname) AS tbl
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname IN ('files', 'file_links')
      AND c.conname LIKE '%document%'
  LOOP
    EXECUTE format(
      'ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
      r.tbl, r.conname, replace(r.conname, 'document', 'file')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- Step 5: the free-standing indexes on the two renamed tables —
--   idx_documents_org_app_created / _run / _chat_session / _expires /
--   _end_user / _application, uq_documents_run_output_dedup,
--   uq_documents_id_org_id, idx_document_links_consumer_run.
-- Same catalog-driven rewrite. Anything already renamed by step 4 no longer
-- matches the LIKE and is skipped.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS idxname, n.nspname AS schemaname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relkind = 'i'
      AND n.nspname = 'public'
      AND t.relname IN ('files', 'file_links')
      AND c.relname LIKE '%document%'
  LOOP
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      r.schemaname, r.idxname, replace(r.idxname, 'document', 'file')
    );
  END LOOP;
END $$;--> statement-breakpoint

-- Step 6: sequences owned by the renamed tables. Neither table has one today
-- (both PKs are application-minted `text`), but a rename never carries a
-- sequence name along, so the pass exists so a future serial column cannot
-- silently keep the old name.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS seqname, n.nspname AS schemaname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    WHERE c.relkind = 'S'
      AND tn.nspname = 'public'
      AND t.relname IN ('files', 'file_links')
      AND c.relname LIKE '%document%'
  LOOP
    EXECUTE format(
      'ALTER SEQUENCE %I.%I RENAME TO %I',
      r.schemaname, r.seqname, replace(r.seqname, 'document', 'file')
    );
  END LOOP;
END $$;
