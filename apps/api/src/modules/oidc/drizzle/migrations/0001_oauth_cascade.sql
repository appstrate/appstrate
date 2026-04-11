-- OIDC module: cascade delete from oauth_client to its child rows.
--
-- The initial migration declared child FKs with ON DELETE NO ACTION, which
-- meant any client that ever minted a token (access, refresh, or consent)
-- could not be deleted via the admin API — the DELETE statement raised a
-- foreign-key violation and the route returned 500. These child rows are
-- meaningless without their parent client, so cascading is the natural
-- semantic.

ALTER TABLE "oauth_access_token"
  DROP CONSTRAINT IF EXISTS "oauth_access_token_client_id_oauth_client_client_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  DROP CONSTRAINT IF EXISTS "oauth_access_token_refresh_id_oauth_refresh_token_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk"
  FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token"
  DROP CONSTRAINT IF EXISTS "oauth_refresh_token_client_id_oauth_client_client_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token"
  ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_consent"
  DROP CONSTRAINT IF EXISTS "oauth_consent_client_id_oauth_client_client_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_consent"
  ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id")
  ON DELETE cascade ON UPDATE no action;
