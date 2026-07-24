-- `document_links` — the cross-container consumption ledger that decides
-- detach-vs-delete when a run is removed — plus the single-container CHECK on
-- `documents`.
--
-- Every statement is RE-RUNNABLE, same discipline as 0020/0021/0023/0024/0025:
-- this database has a history of hand-repaired migration state, and the
-- recovery for that is to replay a migration — unguarded `CREATE TABLE` /
-- `ADD CONSTRAINT` / `CREATE INDEX` would crash-loop the boot on
-- `... already exists`.
--
-- Constraint guards match on the constraint's FORM (referencing table +
-- constraint type + referenced table + the exact set of constrained columns),
-- never on its name — Postgres `_fkey` vs Drizzle `_fk` name drift already
-- broke one production deploy here (see 0028's dual-name drops), and a
-- name-only guard on a drifted database silently adds a DUPLICATE constraint.
CREATE TABLE IF NOT EXISTS "document_links" (
	"document_id" text NOT NULL,
	"consumer_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_document_id_consumer_run_id_pk" PRIMARY KEY("document_id","consumer_run_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.document_links'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.documents'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['document_id']
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.document_links'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'public.runs'::regclass
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['consumer_run_id']
  ) THEN
    ALTER TABLE "document_links" ADD CONSTRAINT "document_links_consumer_run_id_runs_id_fk" FOREIGN KEY ("consumer_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_links_consumer_run" ON "document_links" USING btree ("consumer_run_id");--> statement-breakpoint
-- Single-container CHECK on `documents`. Validated immediately (no NOT VALID):
-- `documents` is created two migrations earlier in this same undeployed batch,
-- so the scan it forces is over an empty table. The ACCESS EXCLUSIVE lock it
-- takes is therefore instantaneous — unlike the same statement on `llm_usage`
-- (see 0023, which defers).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.documents'::regclass
      AND c.contype = 'c'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['chat_session_id','run_id']
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "chk_documents_single_container" CHECK (NOT ("documents"."run_id" IS NOT NULL AND "documents"."chat_session_id" IS NOT NULL));
  END IF;
END $$;
