ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "level" SET DEFAULT 'instance';