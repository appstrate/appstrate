-- OIDC module: initial schema
-- Owns: jwks, oauth_client, oauth_access_token, oauth_refresh_token, oauth_consent,
--       oidc_end_user_profiles
--
-- Requires core tables: "user", "session", "end_users".

CREATE TABLE "jwks" (
  "id" text PRIMARY KEY NOT NULL,
  "public_key" text NOT NULL,
  "private_key" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oauth_client" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "client_secret" text,
  "disabled" boolean DEFAULT false,
  "skip_consent" boolean,
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
  "reference_id" text,
  "metadata" text,
  CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_token" (
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
  "scopes" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_access_token" (
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
  CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "oauth_consent" (
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
ALTER TABLE "oauth_client"
  ADD CONSTRAINT "oauth_client_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token"
  ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token"
  ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token"
  ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_access_token"
  ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk"
  FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_token"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_consent"
  ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_consent"
  ADD CONSTRAINT "oauth_consent_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles"
  ADD CONSTRAINT "oidc_end_user_profiles_end_user_id_end_users_id_fk"
  FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oidc_end_user_profiles"
  ADD CONSTRAINT "oidc_end_user_profiles_auth_user_id_user_id_fk"
  FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_oidc_profiles_auth_user" ON "oidc_end_user_profiles" ("auth_user_id");
