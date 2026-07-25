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
-- Both FKs are declared INLINE in the `CREATE TABLE`, with their explicit
-- Drizzle names so nothing drifts: `CREATE TABLE IF NOT EXISTS` short-circuits
-- on replay, and if the table already exists its own constraints necessarily do
-- too. The single-container CHECK below is different — it lands on `documents`,
-- a table this migration does not create — so it keeps its own guard.
CREATE TABLE IF NOT EXISTS "document_links" (
	"document_id" text NOT NULL,
	"consumer_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_document_id_consumer_run_id_pk" PRIMARY KEY("document_id","consumer_run_id"),
	CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "document_links_consumer_run_id_runs_id_fk" FOREIGN KEY ("consumer_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_links_consumer_run" ON "document_links" USING btree ("consumer_run_id");--> statement-breakpoint
-- Single-container CHECK on `documents`. Validated immediately (no NOT VALID):
-- `documents` is created two migrations earlier in this same undeployed batch,
-- so the scan it forces is over an empty table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_documents_single_container'
      AND conrelid = 'public.documents'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "documents" ADD CONSTRAINT "chk_documents_single_container" CHECK (NOT ("documents"."run_id" IS NOT NULL AND "documents"."chat_session_id" IS NOT NULL));
  END IF;
END $$;
