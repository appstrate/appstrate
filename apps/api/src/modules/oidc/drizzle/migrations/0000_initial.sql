-- OIDC module: initial schema
-- Owns: jwks, oauth_clients, oauth_access_tokens, oauth_refresh_tokens, oauth_consents,
--       oidc_end_user_profiles
--
-- Requires core tables: "user", "session", "end_users", "organizations", "applications".

CREATE TABLE "jwks" (
  "id" text PRIMARY KEY NOT NULL,
  "public_key" text NOT NULL,
  "private_key" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "client_secret" text,
  "disabled" boolean DEFAULT false,
  "is_first_party" boolean DEFAULT false,
  "enable_end_session" boolean,
  "subject_type" text,
  "scopes" text[] DEFAULT '{}',
  "user_id" text,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  "expires_at" timestamp,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" text[],
  "tos" text,
  "policy" text,
  "software_id" text,
  "software_version" text,
  "software_statement" text,
  "redirect_uris" text[] NOT NULL,
  "post_logout_redirect_uris" text[],
  "token_endpoint_auth_method" text,
  "grant_types" text[],
  "response_types" text[],
  "public" boolean,
  "type" text,
  "require_pkce" boolean,
  "metadata" text,
  "level" text NOT NULL,
  "referenced_org_id" uuid,
  "referenced_application_id" text,
  CONSTRAINT "oauth_clients_client_id_unique" UNIQUE ("client_id"),
  CONSTRAINT "oauth_clients_level_check" CHECK (
    (level = 'org' AND referenced_org_id IS NOT NULL AND referenced_application_id IS NULL)
    OR
    (level = 'application' AND referenced_application_id IS NOT NULL AND referenced_org_id IS NULL)
    OR
    (level = 'instance' AND referenced_org_id IS NULL AND referenced_application_id IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "client_id" text NOT NULL,
  "session_id" text,
  "user_id" text NOT NULL,
  "reference_id" text,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "revoked" timestamp,
  "auth_time" timestamp,
  "scopes" text[] NOT NULL,
  CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE ("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "token" text,
  "client_id" text NOT NULL,
  "session_id" text,
  "user_id" text,
  "reference_id" text,
  "refresh_id" text,
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "scopes" text[] NOT NULL,
  CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE ("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "user_id" text,
  "reference_id" text,
  "scopes" text[] NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "oidc_end_user_profiles" (
  "end_user_id" text PRIMARY KEY NOT NULL,
  "auth_user_id" text,
  "status" text DEFAULT 'active' NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_clients"
  ADD CONSTRAINT "oauth_clients_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_clients"
  ADD CONSTRAINT "oauth_clients_referenced_org_id_organizations_id_fk"
  FOREIGN KEY ("referenced_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_clients"
  ADD CONSTRAINT "oauth_clients_referenced_application_id_applications_id_fk"
  FOREIGN KEY ("referenced_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_session_id_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens"
  ADD CONSTRAINT "oauth_refresh_tokens_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens"
  ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens"
  ADD CONSTRAINT "oauth_access_tokens_session_id_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens"
  ADD CONSTRAINT "oauth_access_tokens_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens"
  ADD CONSTRAINT "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk"
  FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_consents"
  ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_consents"
  ADD CONSTRAINT "oauth_consents_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles"
  ADD CONSTRAINT "oidc_end_user_profiles_end_user_id_end_users_id_fk"
  FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles"
  ADD CONSTRAINT "oidc_end_user_profiles_auth_user_id_user_id_fk"
  FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_org" ON "oauth_clients" ("referenced_org_id");
--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_app" ON "oauth_clients" ("referenced_application_id");
--> statement-breakpoint
CREATE INDEX "idx_oidc_profiles_auth_user" ON "oidc_end_user_profiles" ("auth_user_id");
--> statement-breakpoint
-- Enforce oauth_clients.level immutability at the DB layer.
--
-- The service layer already excludes `level` from `UpdateClientInput`, and
-- the CHECK constraint above guarantees the (level, referenced_org_id,
-- referenced_application_id) triplet stays consistent on INSERT. But
-- nothing prevents a raw SQL UPDATE (or a future service-layer typo)
-- from flipping `level` post-hoc and leaving the `metadata` JSON column
-- — which the OIDC plugin reads at token-mint time via
-- `customAccessTokenClaims` — stale relative to the live columns.
--
-- This BEFORE UPDATE trigger makes the invariant unconditional: any
-- attempt to mutate `level` raises `check_violation` and the UPDATE is
-- rejected. Combined with `level` being absent from `UpdateClientInput`,
-- this gives us defense in depth with an audit-friendly error message.
CREATE OR REPLACE FUNCTION oauth_clients_level_immutable_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.level IS DISTINCT FROM OLD.level THEN
    RAISE EXCEPTION 'oauth_clients.level is immutable (attempted change: % -> %)',
      OLD.level, NEW.level
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER oauth_clients_level_immutable
  BEFORE UPDATE ON oauth_clients
  FOR EACH ROW
  EXECUTE FUNCTION oauth_clients_level_immutable_fn();
