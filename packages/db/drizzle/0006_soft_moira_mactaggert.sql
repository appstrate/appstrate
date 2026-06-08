ALTER TABLE "oauth_access_tokens" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "resources" text[];