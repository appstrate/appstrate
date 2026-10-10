-- 0089 — connection shares are rows: one per (connection, space), each with its FKs, so deleting a
-- space or a connection takes its shares with it. Both FKs are composite on the share's `org_id`, so
-- a share names a space of its connection's own org. `integration_connections.shared_space_ids`, its
-- index and its two CHECKs stay for scripts/migration/0044, which copies them into the table. An
-- org-scoped row's `origin_space_id` names a space of the row's own org (composite FK, SET NULL on
-- that column alone). `integration_pins.created_by` and `integration_org_defaults.created_by` go:
-- who set a pin or a default is in the audit trail (`integration.pin.*`, `integration.org_default.*`).
CREATE TABLE "integration_connection_shares" (
	"connection_id" uuid NOT NULL,
	"space_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"shared_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connection_shares_pk" PRIMARY KEY("connection_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "integration_connection_shares" ADD CONSTRAINT "ics_shared_by_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ics_space" ON "integration_connection_shares" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_spaces_id_org_id" ON "spaces" USING btree ("id","org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_integration_conn_id_org_id" ON "integration_connections" USING btree ("id","org_id");--> statement-breakpoint
ALTER TABLE "integration_connection_shares" ADD CONSTRAINT "ics_connection_org_fk" FOREIGN KEY ("connection_id","org_id") REFERENCES "public"."integration_connections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_shares" ADD CONSTRAINT "ics_space_org_fk" FOREIGN KEY ("space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_origin_space_id_spaces_id_fk";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_origin_space_org_fk" FOREIGN KEY ("origin_space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE SET NULL ("origin_space_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" DROP COLUMN "created_by";--> statement-breakpoint
ALTER TABLE "integration_org_defaults" DROP COLUMN "created_by";
