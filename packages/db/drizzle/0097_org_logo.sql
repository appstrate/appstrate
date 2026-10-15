-- An organization's logo: `emoji:<char>` or `image:<version>` (bytes in object storage), null when unset.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logo" text;
