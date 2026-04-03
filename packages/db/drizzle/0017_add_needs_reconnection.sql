ALTER TABLE "user_provider_connections" ADD COLUMN IF NOT EXISTS "needs_reconnection" boolean DEFAULT false NOT NULL;
