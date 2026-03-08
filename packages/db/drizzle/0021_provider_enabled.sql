ALTER TABLE "provider_credentials" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT false;
UPDATE "provider_credentials" SET "enabled" = true WHERE "credentials_encrypted" IS NOT NULL;
