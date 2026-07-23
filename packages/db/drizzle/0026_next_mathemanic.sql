CREATE TABLE "document_links" (
	"document_id" text NOT NULL,
	"consumer_run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_document_id_consumer_run_id_pk" PRIMARY KEY("document_id","consumer_run_id")
);
--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_consumer_run_id_runs_id_fk" FOREIGN KEY ("consumer_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_links_consumer_run" ON "document_links" USING btree ("consumer_run_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "chk_documents_single_container" CHECK (NOT ("documents"."run_id" IS NOT NULL AND "documents"."chat_session_id" IS NOT NULL));