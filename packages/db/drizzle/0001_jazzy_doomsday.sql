CREATE TABLE "share_link_usages" (
	"id" text PRIMARY KEY NOT NULL,
	"share_link_id" text NOT NULL,
	"execution_id" text,
	"ip" text,
	"user_agent" text,
	"used_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "share_tokens" RENAME TO "share_links";--> statement-breakpoint
ALTER TABLE "executions" RENAME COLUMN "share_token_id" TO "share_link_id";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_token_unique";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_at_most_one_actor";--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_package_id_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_tokens_end_user_id_end_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_executions_share_token_id";--> statement-breakpoint
DROP INDEX "idx_share_tokens_token";--> statement-breakpoint
DROP INDEX "idx_share_tokens_package_id";--> statement-breakpoint
DROP INDEX "idx_share_tokens_org_id";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_link_usages" ADD CONSTRAINT "share_link_usages_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_usages" ADD CONSTRAINT "share_link_usages_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_share_link_usages_link_id" ON "share_link_usages" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "idx_share_link_usages_lookup" ON "share_link_usages" USING btree ("share_link_id","used_at");--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_executions_share_link_id" ON "executions" USING btree ("share_link_id");--> statement-breakpoint
CREATE INDEX "idx_share_links_token" ON "share_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_share_links_package_id" ON "share_links" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_share_links_org_id" ON "share_links" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN "consumed_at";--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_token_unique" UNIQUE("token");--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_at_most_one_actor" CHECK (NOT (created_by IS NOT NULL AND end_user_id IS NOT NULL));