-- One-shot pairing tokens that bridge the dashboard "Connect Claude Pro"
-- button with the `npx @appstrate/connect-helper <token>` loopback OAuth
-- helper running on the user's machine.
--
-- The plaintext token is `appp_<base64url(header)>.<base64url(secret)>`;
-- only the SHA-256 of the secret portion is persisted as `token_hash`.
-- See `packages/db/src/schema/organizations.ts` (modelProviderPairings)
-- and `apps/api/src/services/oauth-model-providers/pairings.ts`.
CREATE TABLE IF NOT EXISTS "model_provider_pairings" (
  "id" text PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" text NOT NULL,
  "org_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "consumed_from_ip" text,
  "credential_id" uuid,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "model_provider_pairings_token_hash_unique" UNIQUE ("token_hash")
);
--> statement-breakpoint

ALTER TABLE "model_provider_pairings"
  ADD CONSTRAINT "model_provider_pairings_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "model_provider_pairings"
  ADD CONSTRAINT "model_provider_pairings_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_model_provider_pairings_org_id"
  ON "model_provider_pairings" ("org_id");
--> statement-breakpoint

-- Partial index: only unconsumed rows participate in the cleanup scan.
-- Keeps footprint proportional to pending population, not the consumed
-- audit-window tail.
CREATE INDEX IF NOT EXISTS "idx_model_provider_pairings_expires_at"
  ON "model_provider_pairings" ("expires_at")
  WHERE "consumed_at" IS NULL;
