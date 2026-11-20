CREATE TABLE "sso_connections" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"tenant_linked_by" text,
	"tenant_linked_at" timestamp with time zone,
	"join_role" text DEFAULT 'member' NOT NULL,
	"enforced_at" timestamp with time zone,
	"enforced_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_join_role_check" CHECK ("sso_connections"."join_role" IN ('member', 'guest')),
	CONSTRAINT "sso_connections_enforced_needs_tenant" CHECK ("sso_connections"."enforced_at" IS NULL OR "sso_connections"."tenant_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_org_domain_idx" ON "sso_domains" USING btree ("org_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_verified_domain_idx" ON "sso_domains" USING btree ("domain") WHERE "sso_domains"."verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sso_sessions_created_at_idx" ON "sso_sessions" USING btree ("created_at");