CREATE TABLE "flow_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"content" text NOT NULL,
	"execution_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "flow_memories" ADD CONSTRAINT "flow_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_memories" ADD CONSTRAINT "flow_memories_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_flow_memories_flow_org" ON "flow_memories" USING btree ("flow_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_flow_memories_org_id" ON "flow_memories" USING btree ("org_id");