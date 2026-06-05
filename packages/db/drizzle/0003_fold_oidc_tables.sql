-- Adopt the OIDC tables into the core schema (formerly owned + migrated by
-- the OIDC module). Idempotent: fresh DBs create all 10 tables + the
-- oauth_clients level-immutability trigger; existing installs (tables already
-- present) no-op via the to_regclass guard. DDL parity verified against the
-- module migrations with a pg_dump diff.
DO $do$
BEGIN
	IF to_regclass('public.oauth_clients') IS NULL THEN
		CREATE TABLE "application_smtp_configs" (
			"application_id" text PRIMARY KEY NOT NULL,
			"host" text NOT NULL,
			"port" integer NOT NULL,
			"username" text NOT NULL,
			"pass_encrypted" text NOT NULL,
			"encryption_key_version" text DEFAULT 'v1' NOT NULL,
			"from_address" text NOT NULL,
			"from_name" text,
			"secure_mode" text DEFAULT 'auto' NOT NULL,
			"created_at" timestamp DEFAULT now() NOT NULL,
			"updated_at" timestamp DEFAULT now() NOT NULL,
			CONSTRAINT "application_smtp_configs_secure_mode_check" CHECK (secure_mode IN ('auto', 'tls', 'starttls', 'none'))
		);
		CREATE TABLE "application_social_providers" (
			"application_id" text NOT NULL,
			"provider" text NOT NULL,
			"client_id" text NOT NULL,
			"client_secret_encrypted" text NOT NULL,
			"encryption_key_version" text DEFAULT 'v1' NOT NULL,
			"scopes" text[],
			"created_at" timestamp DEFAULT now() NOT NULL,
			"updated_at" timestamp DEFAULT now() NOT NULL,
			CONSTRAINT "application_social_providers_application_id_provider_pk" PRIMARY KEY("application_id","provider"),
			CONSTRAINT "application_social_providers_provider_check" CHECK (provider IN ('google', 'github'))
		);
		CREATE TABLE "cli_refresh_tokens" (
			"id" text PRIMARY KEY NOT NULL,
			"token_hash" text NOT NULL,
			"user_id" text NOT NULL,
			"client_id" text NOT NULL,
			"family_id" text NOT NULL,
			"parent_id" text,
			"scope" text,
			"expires_at" timestamp NOT NULL,
			"created_at" timestamp DEFAULT now() NOT NULL,
			"used_at" timestamp,
			"revoked_at" timestamp,
			"revoked_reason" text,
			"device_name" text,
			"user_agent" text,
			"created_ip" text,
			"last_used_ip" text,
			"last_used_at" timestamp,
			CONSTRAINT "cli_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
		);
		CREATE TABLE "device_codes" (
			"id" text PRIMARY KEY NOT NULL,
			"device_code" text NOT NULL,
			"user_code" text NOT NULL,
			"user_id" text,
			"expires_at" timestamp NOT NULL,
			"status" text NOT NULL,
			"last_polled_at" timestamp,
			"polling_interval" integer,
			"client_id" text,
			"scope" text,
			"attempts" integer DEFAULT 0 NOT NULL,
			CONSTRAINT "device_codes_device_code_unique" UNIQUE("device_code"),
			CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
		);
		CREATE TABLE "jwks" (
			"id" text PRIMARY KEY NOT NULL,
			"public_key" text NOT NULL,
			"private_key" text NOT NULL,
			"created_at" timestamp DEFAULT now() NOT NULL,
			"expires_at" timestamp
		);
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
			CONSTRAINT "oauth_access_tokens_token_unique" UNIQUE("token")
		);
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
			"allow_signup" boolean DEFAULT false NOT NULL,
			"signup_role" text DEFAULT 'member' NOT NULL,
			CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
			CONSTRAINT "oauth_clients_level_check" CHECK ((level = 'org' AND referenced_org_id IS NOT NULL AND referenced_application_id IS NULL) OR (level = 'application' AND referenced_application_id IS NOT NULL AND referenced_org_id IS NULL) OR (level = 'instance' AND referenced_org_id IS NULL AND referenced_application_id IS NULL)),
			CONSTRAINT "oauth_clients_signup_role_check" CHECK (signup_role IN ('admin', 'member', 'viewer'))
		);
		CREATE TABLE "oauth_consents" (
			"id" text PRIMARY KEY NOT NULL,
			"client_id" text NOT NULL,
			"user_id" text,
			"reference_id" text,
			"scopes" text[] NOT NULL,
			"created_at" timestamp DEFAULT now(),
			"updated_at" timestamp DEFAULT now()
		);
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
			CONSTRAINT "oauth_refresh_tokens_token_unique" UNIQUE("token")
		);
		CREATE TABLE "oidc_end_user_profiles" (
			"end_user_id" text PRIMARY KEY NOT NULL,
			"auth_user_id" text,
			"status" text DEFAULT 'active' NOT NULL,
			"email_verified" boolean DEFAULT false NOT NULL,
			"created_at" timestamp DEFAULT now() NOT NULL,
			"updated_at" timestamp DEFAULT now() NOT NULL
		);
		ALTER TABLE "application_smtp_configs" ADD CONSTRAINT "application_smtp_configs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "application_social_providers" ADD CONSTRAINT "application_social_providers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cli_refresh_tokens" ADD CONSTRAINT "cli_refresh_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cli_refresh_tokens" ADD CONSTRAINT "cli_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "cli_refresh_tokens" ADD CONSTRAINT "cli_refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."cli_refresh_tokens"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_oauth_refresh_tokens_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_referenced_org_id_organizations_id_fk" FOREIGN KEY ("referenced_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_referenced_application_id_applications_id_fk" FOREIGN KEY ("referenced_application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;
		ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oidc_end_user_profiles" ADD CONSTRAINT "oidc_end_user_profiles_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;
		ALTER TABLE "oidc_end_user_profiles" ADD CONSTRAINT "oidc_end_user_profiles_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
		CREATE INDEX "idx_cli_refresh_tokens_family" ON "cli_refresh_tokens" USING btree ("family_id");
		CREATE INDEX "idx_cli_refresh_tokens_user" ON "cli_refresh_tokens" USING btree ("user_id");
		CREATE INDEX "idx_oauth_clients_org" ON "oauth_clients" USING btree ("referenced_org_id");
		CREATE INDEX "idx_oauth_clients_app" ON "oauth_clients" USING btree ("referenced_application_id");
		CREATE INDEX "idx_oidc_profiles_auth_user" ON "oidc_end_user_profiles" USING btree ("auth_user_id");
		-- BEFORE UPDATE trigger enforcing oauth_clients.level immutability.
		-- Not expressible in Drizzle; carried verbatim from the module 0000 migration.
		CREATE OR REPLACE FUNCTION oauth_clients_level_immutable_fn()
		RETURNS TRIGGER AS $fn$
		BEGIN
			IF NEW.level IS DISTINCT FROM OLD.level THEN
				RAISE EXCEPTION 'oauth_clients.level is immutable (attempted change: % -> %)',
					OLD.level, NEW.level
					USING ERRCODE = 'check_violation';
			END IF;
			RETURN NEW;
		END;
		$fn$ LANGUAGE plpgsql;
		CREATE TRIGGER oauth_clients_level_immutable
			BEFORE UPDATE ON oauth_clients
			FOR EACH ROW
			EXECUTE FUNCTION oauth_clients_level_immutable_fn();
	END IF;
END $do$;
--> statement-breakpoint
-- Existing installs only: drop the obsolete per-module migration tracking table.
DROP TABLE IF EXISTS "__drizzle_migrations_oidc";
