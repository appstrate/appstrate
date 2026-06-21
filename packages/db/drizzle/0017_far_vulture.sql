CREATE TABLE "search_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_item_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"owner_id" text,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_search_chunks_item_index" UNIQUE("search_item_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "search_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"storage_object_id" text NOT NULL,
	"name" text,
	"mime" text,
	"visibility" text DEFAULT 'org' NOT NULL,
	"owner_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_search_items_org_object" UNIQUE("org_id","storage_object_id"),
	CONSTRAINT "search_items_visibility_values" CHECK (visibility IN ('org', 'private')),
	CONSTRAINT "search_items_status_values" CHECK (status IN ('pending', 'indexed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "search_chunks" ADD CONSTRAINT "search_chunks_search_item_id_search_items_id_fk" FOREIGN KEY ("search_item_id") REFERENCES "public"."search_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_chunks" ADD CONSTRAINT "search_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_items" ADD CONSTRAINT "search_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_search_chunks_org" ON "search_chunks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_search_items_org" ON "search_items" USING btree ("org_id");--> statement-breakpoint
DO $$
BEGIN
  -- pgvector is OPTIONAL: on a Postgres without the extension binaries this
  -- block logs a notice and the deployment boots normally — the search module
  -- detects the missing column and degrades to keyword search.
  -- (PGlite Tier 0 bundles pgvector; managed Postgres usually ships it.)
  -- The `embedding` column is kept OUT of the CREATE TABLE above and added
  -- here so the table itself never depends on the extension type existing.
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE "search_chunks" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
  CREATE INDEX IF NOT EXISTS "idx_search_chunks_embedding"
    ON "search_chunks" USING hnsw ("embedding" vector_cosine_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector unavailable (%) — semantic search disabled, keyword search only', SQLERRM;
END $$;
