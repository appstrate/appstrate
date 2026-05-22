CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."llm_usage_source" AS ENUM('proxy', 'runner');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."package_source" AS ENUM('local', 'system');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('agent', 'skill', 'integration');--> statement-breakpoint
CREATE TYPE "public"."run_origin" AS ENUM('platform', 'remote');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'success', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"realm" text DEFAULT 'platform' NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"realm" text DEFAULT 'platform' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"provider_id" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"base_url_override" text,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_pairings" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_from_ip" text,
	"credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_provider_pairings_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "org_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"email" text NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "org_role" NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by" text,
	"accepted_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "org_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"model_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"input" jsonb,
	"context_window" integer,
	"max_tokens" integer,
	"reasoning" boolean,
	"cost" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_models_source_valid" CHECK (source IN ('built-in', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "org_proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"url_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_proxies_source_valid" CHECK (source IN ('built-in', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"org_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "end_users" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"external_id" text,
	"name" text,
	"email" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"language" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "language_check" CHECK ("profiles"."language" IN ('fr', 'en'))
);
--> statement-breakpoint
CREATE TABLE "application_packages" (
	"application_id" text NOT NULL,
	"package_id" text NOT NULL,
	"version_id" integer,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_id" text,
	"proxy_id" text,
	"block_user_connections" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_packages_application_id_package_id_pk" PRIMARY KEY("application_id","package_id")
);
--> statement-breakpoint
CREATE TABLE "package_dist_tags" (
	"package_id" text NOT NULL,
	"tag" text NOT NULL,
	"version_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_dist_tags_package_id_tag_pk" PRIMARY KEY("package_id","tag")
);
--> statement-breakpoint
CREATE TABLE "package_version_dependencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL,
	"dep_scope" text NOT NULL,
	"dep_name" text NOT NULL,
	"dep_type" "package_type" NOT NULL,
	"version_range" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"version" text NOT NULL,
	"integrity" text NOT NULL,
	"artifact_size" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"yanked" boolean DEFAULT false NOT NULL,
	"yanked_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"type" "package_type" NOT NULL,
	"source" "package_source" DEFAULT 'local' NOT NULL,
	"draft_manifest" jsonb,
	"draft_content" text,
	"auto_installed" boolean DEFAULT false NOT NULL,
	"ephemeral" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lock_version" integer DEFAULT 1 NOT NULL,
	"forked_from" text,
	CONSTRAINT "packages_id_format" CHECK ("packages"."id" ~ '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE TABLE "credential_proxy_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"api_key_id" text,
	"user_id" text,
	"run_id" text,
	"application_id" text,
	"provider_id" text NOT NULL,
	"target_host" text,
	"http_status" integer,
	"duration_ms" integer,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_proxy_usage_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "credential_proxy_usage_principal_single" CHECK (api_key_id IS NULL OR user_id IS NULL)
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" "llm_usage_source" NOT NULL,
	"org_id" uuid NOT NULL,
	"api_key_id" text,
	"user_id" text,
	"run_id" text,
	"model" text,
	"real_model" text,
	"api" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_principal_single" CHECK (api_key_id IS NULL OR user_id IS NULL),
	CONSTRAINT "llm_usage_proxy_has_request_id" CHECK (source <> 'proxy' OR request_id IS NOT NULL),
	CONSTRAINT "llm_usage_runner_has_run_id" CHECK (source <> 'runner' OR run_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "package_persistence" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"application_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"content" jsonb NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pkp_actor_type_valid" CHECK (actor_type IN ('user', 'end_user', 'shared')),
	CONSTRAINT "pkp_actor_id_shape" CHECK ((actor_type = 'shared' AND actor_id IS NULL) OR (actor_type <> 'shared' AND actor_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "run_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text DEFAULT 'progress' NOT NULL,
	"level" text DEFAULT 'debug' NOT NULL,
	"event" text,
	"message" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_logs_level_valid" CHECK (level IN ('debug', 'info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text,
	"user_id" text,
	"end_user_id" text,
	"application_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"checkpoint" jsonb,
	"error" text,
	"token_usage" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration" integer,
	"schedule_id" text,
	"version_label" text,
	"version_dirty" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"proxy_label" text,
	"model_label" text,
	"model_source" text,
	"cost" double precision,
	"run_number" integer,
	"connection_overrides" jsonb,
	"resolved_connections" jsonb,
	"api_key_id" text,
	"metadata" jsonb,
	"config" jsonb,
	"config_override" jsonb,
	"agent_scope" text,
	"agent_name" text,
	"run_origin" "run_origin" DEFAULT 'platform' NOT NULL,
	"sink_secret_encrypted" text,
	"sink_expires_at" timestamp with time zone,
	"sink_closed_at" timestamp with time zone,
	"last_event_sequence" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context_snapshot" jsonb,
	"runner_name" text,
	"runner_kind" text,
	"model_credential_id" uuid,
	CONSTRAINT "runs_at_most_one_actor" CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL)),
	CONSTRAINT "runs_open_sink_has_secret" CHECK (sink_expires_at IS NULL OR sink_secret_encrypted IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "package_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC',
	"input" jsonb,
	"config_override" jsonb,
	"model_id_override" text,
	"proxy_id_override" text,
	"version_override" text,
	"connection_overrides" jsonb,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_schedules_at_most_one_actor" CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_package_id" text NOT NULL,
	"auth_key" text NOT NULL,
	"account_id" text NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"credentials_encrypted" text NOT NULL,
	"identity_claims" jsonb,
	"scopes_granted" text[] DEFAULT '{}'::text[] NOT NULL,
	"needs_reconnection" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"label" text,
	"shared_with_org" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_conn_exactly_one_owner" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "integration_oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"integration_package_id" text NOT NULL,
	"auth_key" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"redirect_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"package_id" text NOT NULL,
	"integration_package_id" text NOT NULL,
	"user_id" text,
	"connection_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_org_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"integration_package_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"enforce" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"created_by" text,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_credential_id_model_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."model_provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_credential_id_model_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."model_provider_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_proxies" ADD CONSTRAINT "org_proxies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_proxies" ADD CONSTRAINT "org_proxies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_packages" ADD CONSTRAINT "application_packages_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_packages" ADD CONSTRAINT "application_packages_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_packages" ADD CONSTRAINT "application_packages_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ADD CONSTRAINT "package_version_dependencies_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_proxy_usage" ADD CONSTRAINT "credential_proxy_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_proxy_usage" ADD CONSTRAINT "credential_proxy_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_proxy_usage" ADD CONSTRAINT "credential_proxy_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_proxy_usage" ADD CONSTRAINT "credential_proxy_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_proxy_usage" ADD CONSTRAINT "credential_proxy_usage_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_persistence" ADD CONSTRAINT "package_persistence_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_persistence" ADD CONSTRAINT "package_persistence_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_persistence" ADD CONSTRAINT "package_persistence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_persistence" ADD CONSTRAINT "package_persistence_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_package_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."package_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_credential_id_model_provider_credentials_id_fk" FOREIGN KEY ("model_credential_id") REFERENCES "public"."model_provider_credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_integration_package_id_packages_id_fk" FOREIGN KEY ("integration_package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "integration_oauth_clients_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_oauth_clients" ADD CONSTRAINT "integration_oauth_clients_integration_package_id_packages_id_fk" FOREIGN KEY ("integration_package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_integration_package_id_packages_id_fk" FOREIGN KEY ("integration_package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_pins" ADD CONSTRAINT "integration_pins_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_integration_package_id_packages_id_fk" FOREIGN KEY ("integration_package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_org_defaults" ADD CONSTRAINT "integration_org_defaults_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_realm_idx" ON "session" USING btree ("realm");--> statement-breakpoint
CREATE INDEX "user_realm_idx" ON "user" USING btree ("realm");--> statement-breakpoint
CREATE INDEX "idx_api_keys_org_id" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_application_id" ON "api_keys" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_key_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "idx_model_provider_credentials_org_id" ON "model_provider_credentials" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_credentials_org_provider" ON "model_provider_credentials" USING btree ("org_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_credentials_expires_at_oauth" ON "model_provider_credentials" USING btree ("expires_at") WHERE "model_provider_credentials"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_model_provider_pairings_org_id" ON "model_provider_pairings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_pairings_expires_at" ON "model_provider_pairings" USING btree ("expires_at") WHERE consumed_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_org_invitations_token" ON "org_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_org_id" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_email" ON "org_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_org_models_org_id" ON "org_models" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_models_one_default" ON "org_models" USING btree ("org_id") WHERE "org_models"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_org_proxies_org_id" ON "org_proxies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_proxies_one_default" ON "org_proxies" USING btree ("org_id") WHERE "org_proxies"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_org_members_user_id" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_applications_org_id" ON "applications" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_applications_one_default" ON "applications" USING btree ("org_id") WHERE "applications"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_end_users_external_id" ON "end_users" USING btree ("application_id","external_id") WHERE "end_users"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_end_users_app_email" ON "end_users" USING btree ("application_id","email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_end_users_application_id" ON "end_users" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_end_users_org_id" ON "end_users" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_application_packages_package_id" ON "application_packages" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_application_packages_app_id" ON "application_packages" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pkg_ver_deps_unique" ON "package_version_dependencies" USING btree ("version_id","dep_scope","dep_name","dep_type");--> statement-breakpoint
CREATE INDEX "idx_pkg_ver_deps_version_id" ON "package_version_dependencies" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_pkg_version_unique" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "idx_package_versions_package_id" ON "package_versions" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_packages_org_id" ON "packages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_packages_type" ON "packages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_packages_org_type" ON "packages" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_packages_ephemeral_created" ON "packages" USING btree ("created_at") WHERE "packages"."ephemeral" = true;--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_org_id" ON "credential_proxy_usage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_run_id" ON "credential_proxy_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_org_created" ON "credential_proxy_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_org_id" ON "llm_usage" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_api_key_id" ON "llm_usage" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user_id" ON "llm_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_run_id" ON "llm_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_org_created" ON "llm_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_usage_proxy_request_id" ON "llm_usage" USING btree ("request_id") WHERE source = 'proxy' AND request_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_llm_usage_runner_run_id" ON "llm_usage" USING btree ("run_id") WHERE source = 'runner' AND run_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pkp_key_unique" ON "package_persistence" USING btree ("package_id","application_id","actor_type",(COALESCE("actor_id", '__shared__')),"key") WHERE key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pkp_lookup" ON "package_persistence" USING btree ("package_id","application_id","actor_type","actor_id","key","pinned");--> statement-breakpoint
CREATE INDEX "pkp_org" ON "package_persistence" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_run_id" ON "run_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_lookup" ON "run_logs" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_org_id" ON "run_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_runs_package_id" ON "runs" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_runs_user_id" ON "runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_end_user_id" ON "runs" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_package_started" ON "runs" USING btree ("package_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_schedule_id" ON "runs" USING btree ("schedule_id") WHERE "runs"."schedule_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_app_status_started" ON "runs" USING btree ("application_id","status","started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_org_id" ON "runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_runs_notification" ON "runs" USING btree ("user_id","org_id","notified_at","read_at");--> statement-breakpoint
CREATE INDEX "idx_runs_sink_expires_at" ON "runs" USING btree ("sink_expires_at") WHERE "runs"."sink_expires_at" IS NOT NULL AND "runs"."sink_closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_stall_sweep" ON "runs" USING btree ("last_heartbeat_at") WHERE "runs"."sink_closed_at" IS NULL AND "runs"."sink_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_schedules_package_id" ON "package_schedules" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_user_id" ON "package_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_end_user_id" ON "package_schedules" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "idx_package_schedules_org_id" ON "package_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_package_schedules_app_id" ON "package_schedules" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_integration_conn_lookup" ON "integration_connections" USING btree ("integration_package_id","application_id","auth_key");--> statement-breakpoint
CREATE INDEX "idx_integration_conn_user" ON "integration_connections" USING btree ("user_id") WHERE "integration_connections"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_end_user" ON "integration_connections" USING btree ("end_user_id") WHERE "integration_connections"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_integration_conn_app" ON "integration_connections" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_integration_conn_shared" ON "integration_connections" USING btree ("application_id","integration_package_id","auth_key") WHERE "integration_connections"."shared_with_org" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_oauth_clients_unique" ON "integration_oauth_clients" USING btree ("application_id","integration_package_id","auth_key");--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_clients_app" ON "integration_oauth_clients" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_integration_oauth_clients_package" ON "integration_oauth_clients" USING btree ("integration_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_pins_unique" ON "integration_pins" USING btree ("application_id","package_id","integration_package_id",coalesce("user_id", ''));--> statement-breakpoint
CREATE INDEX "idx_integration_pins_app_pkg" ON "integration_pins" USING btree ("application_id","package_id");--> statement-breakpoint
CREATE INDEX "idx_integration_pins_connection" ON "integration_pins" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_integration_pins_user" ON "integration_pins" USING btree ("user_id") WHERE "integration_pins"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_org_defaults_unique" ON "integration_org_defaults" USING btree ("application_id","integration_package_id");--> statement-breakpoint
CREATE INDEX "idx_integration_org_defaults_app" ON "integration_org_defaults" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_integration_org_defaults_connection" ON "integration_org_defaults" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_app" ON "uploads" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_expires_unconsumed" ON "uploads" USING btree ("expires_at") WHERE "uploads"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_events_org_created" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_resource" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "idx_audit_events_actor" ON "audit_events" USING btree ("actor_type","actor_id");