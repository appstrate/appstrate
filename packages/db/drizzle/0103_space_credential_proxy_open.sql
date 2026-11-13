-- Per-space switch closing the credential proxy outside a run (#2204). The default keeps every existing space open.
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "credential_proxy_open" boolean DEFAULT true NOT NULL;
