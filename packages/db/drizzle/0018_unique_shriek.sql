DROP INDEX "idx_org_proxies_one_default";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "default_proxy_id" text;--> statement-breakpoint
ALTER TABLE "org_proxies" DROP COLUMN "is_default";