ALTER TYPE "public"."auth_mode" ADD VALUE 'oauth1' BEFORE 'api_key';--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "oauth_token_secret" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "auth_mode" text DEFAULT 'oauth2' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD COLUMN "request_token_url" text;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD COLUMN "access_token_url" text;