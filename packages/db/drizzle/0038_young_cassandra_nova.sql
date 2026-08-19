-- Canonicalise before constraining. A row holding an EMPTY ciphertext with no
-- declared method is a public client that predates the column — structurally
-- it satisfies neither branch of the constraint below, so adding the
-- constraint without this UPDATE would fail at boot and take the platform
-- down with it. No current code path writes an empty ciphertext, but that is
-- an assumption about production data this migration must not depend on.
UPDATE "integration_oauth_clients"
   SET "token_endpoint_auth_method" = 'none'
 WHERE "token_endpoint_auth_method" IS NULL
   AND "client_secret_encrypted" = '';
--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "ioc_public_iff_no_secret" CHECK (("integration_oauth_clients"."token_endpoint_auth_method" = 'none' AND "integration_oauth_clients"."client_secret_encrypted" = '') OR ("integration_oauth_clients"."token_endpoint_auth_method" IS DISTINCT FROM 'none' AND "integration_oauth_clients"."client_secret_encrypted" <> ''));
