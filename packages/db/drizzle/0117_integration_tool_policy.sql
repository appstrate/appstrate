-- Tool snapshots, per-space tool approvals and blocks, and the `integration_tools_review` notification
-- kind (its CHECK re-stated, plus one unread notice per space, recipient and integration).
CREATE TABLE "integration_tool_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"connection_id" uuid,
	"listed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "uq_integration_tool_snapshots_target" UNIQUE NULLS NOT DISTINCT("org_id","package_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "space_integration_tool_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"definition" jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_integration_tool_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"blocked_by" text,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_valid";--> statement-breakpoint
ALTER TABLE "integration_tool_snapshots" ADD CONSTRAINT "integration_tool_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_snapshots" ADD CONSTRAINT "integration_tool_snapshots_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_tool_snapshots" ADD CONSTRAINT "integration_tool_snapshots_connection_org_fk" FOREIGN KEY ("connection_id","org_id") REFERENCES "public"."integration_connections"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_approvals" ADD CONSTRAINT "space_integration_tool_approvals_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_approvals" ADD CONSTRAINT "space_integration_tool_approvals_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_approvals" ADD CONSTRAINT "space_integration_tool_approvals_space_org_fk" FOREIGN KEY ("space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_blocks" ADD CONSTRAINT "space_integration_tool_blocks_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_blocks" ADD CONSTRAINT "space_integration_tool_blocks_blocked_by_user_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_integration_tool_blocks" ADD CONSTRAINT "space_integration_tool_blocks_space_org_fk" FOREIGN KEY ("space_id","org_id") REFERENCES "public"."spaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_integration_tool_snapshots_connection" ON "integration_tool_snapshots" USING btree ("connection_id") WHERE "integration_tool_snapshots"."connection_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_tool_snapshots_package" ON "integration_tool_snapshots" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_space_integration_tool_approvals" ON "space_integration_tool_approvals" USING btree ("space_id","package_id","tool_name","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_space_integration_tool_approvals_package" ON "space_integration_tool_approvals" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_space_integration_tool_approvals_approved_by" ON "space_integration_tool_approvals" USING btree ("approved_by") WHERE "space_integration_tool_approvals"."approved_by" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_space_integration_tool_blocks" ON "space_integration_tool_blocks" USING btree ("space_id","package_id","tool_name");--> statement-breakpoint
CREATE INDEX "idx_space_integration_tool_blocks_package" ON "space_integration_tool_blocks" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_space_integration_tool_blocks_blocked_by" ON "space_integration_tool_blocks" USING btree ("blocked_by") WHERE "space_integration_tool_blocks"."blocked_by" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_tools_review_unread" ON "notifications" USING btree ("space_id","recipient_type","recipient_id",("payload"->>'packageId')) WHERE "notifications"."type" = 'integration_tools_review' AND "notifications"."read_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_valid" CHECK (type IN ('run_failed', 'package_shared', 'agent_message', 'credential_needs_reconnection', 'integration_tools_review'));