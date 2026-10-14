-- An organization's logo: `emoji:<char>` or a WebP data URL, null when unset.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logo" text;
