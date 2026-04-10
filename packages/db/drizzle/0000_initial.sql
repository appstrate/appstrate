CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."package_source" AS ENUM('local', 'system');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('agent', 'skill', 'tool', 'provider');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'success', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "org_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"api" text NOT NULL,
	"base_url" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_key_id" uuid NOT NULL,
	"input" jsonb,
	"context_window" integer,
	"max_tokens" integer,
	"reasoning" boolean,
	"cost" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'custom' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"api" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"language" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
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
	"app_profile_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "application_packages_application_id_package_id_pk" PRIMARY KEY("application_id","package_id")
);
--> statement-breakpoint
CREATE TABLE "package_dist_tags" (
	"package_id" text NOT NULL,
	"tag" text NOT NULL,
	"version_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
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
	"created_at" timestamp DEFAULT now() NOT NULL
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
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"lock_version" integer DEFAULT 1 NOT NULL,
	"forked_from" text,
	CONSTRAINT "packages_id_format" CHECK ("packages"."id" ~ '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE TABLE "package_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"content" text NOT NULL,
	"run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"connection_profile_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"application_id" text NOT NULL,
	"name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC',
	"input" jsonb,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"application_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"state" jsonb,
	"error" text,
	"token_usage" jsonb,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"duration" integer,
	"connection_profile_id" uuid,
	"schedule_id" text,
	"version_label" text,
	"version_dirty" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp,
	"read_at" timestamp,
	"proxy_label" text,
	"model_label" text,
	"model_source" text,
	"cost" double precision,
	"run_number" integer,
	"provider_profile_ids" jsonb,
	"provider_statuses" jsonb,
	"api_key_id" text,
	"metadata" jsonb,
	CONSTRAINT "runs_at_most_one_actor" CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "app_profile_provider_bindings" (
	"app_profile_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"source_profile_id" uuid NOT NULL,
	"bound_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_profile_provider_bindings_app_profile_id_provider_id_pk" PRIMARY KEY("app_profile_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "application_provider_credentials" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"application_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "application_provider_credentials_application_id_provider_id_pk" PRIMARY KEY("application_id","provider_id"),
	CONSTRAINT "application_provider_credentials_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "connection_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"end_user_id" text,
	"application_id" text,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "connection_profiles_exactly_one_owner" CHECK ((
        (user_id IS NOT NULL AND end_user_id IS NULL AND application_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NOT NULL AND application_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NULL AND application_id IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "user_agent_provider_profiles" (
	"user_id" text,
	"end_user_id" text,
	"package_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ufpp_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_credential_id" uuid NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"scopes_granted" text[] DEFAULT '{}'::text[] NOT NULL,
	"needs_reconnection" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_provider_key_id_org_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."org_provider_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "application_packages" ADD CONSTRAINT "application_packages_app_profile_id_connection_profiles_id_fk" FOREIGN KEY ("app_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ADD CONSTRAINT "package_version_dependencies_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_connection_profile_id_connection_profiles_id_fk" FOREIGN KEY ("connection_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_logs" ADD CONSTRAINT "run_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_connection_profile_id_connection_profiles_id_fk" FOREIGN KEY ("connection_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_package_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."package_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_profile_provider_bindings" ADD CONSTRAINT "app_profile_provider_bindings_app_profile_id_connection_profiles_id_fk" FOREIGN KEY ("app_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_profile_provider_bindings" ADD CONSTRAINT "app_profile_provider_bindings_source_profile_id_connection_profiles_id_fk" FOREIGN KEY ("source_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_profile_provider_bindings" ADD CONSTRAINT "app_profile_provider_bindings_bound_by_user_id_user_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD CONSTRAINT "application_provider_credentials_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD CONSTRAINT "application_provider_credentials_provider_id_packages_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_provider_profiles" ADD CONSTRAINT "user_agent_provider_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_provider_profiles" ADD CONSTRAINT "user_agent_provider_profiles_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_provider_profiles" ADD CONSTRAINT "user_agent_provider_profiles_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_agent_provider_profiles" ADD CONSTRAINT "user_agent_provider_profiles_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_provider_credential_id_application_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."application_provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_org_id" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_application_id" ON "api_keys" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_key_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_token" ON "org_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_org_id" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_email" ON "org_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_org_models_org_id" ON "org_models" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_models_one_default" ON "org_models" USING btree ("org_id") WHERE "org_models"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_org_provider_keys_org_id" ON "org_provider_keys" USING btree ("org_id");--> statement-breakpoint
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
CREATE INDEX "idx_application_packages_app_profile_id" ON "application_packages" USING btree ("app_profile_id");--> statement-breakpoint
CREATE INDEX "idx_application_packages_app_id" ON "application_packages" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pkg_ver_deps_unique" ON "package_version_dependencies" USING btree ("version_id","dep_scope","dep_name","dep_type");--> statement-breakpoint
CREATE INDEX "idx_pkg_ver_deps_version_id" ON "package_version_dependencies" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_pkg_version_unique" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "idx_package_versions_package_id" ON "package_versions" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_packages_org_id" ON "packages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_packages_type" ON "packages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_packages_org_type" ON "packages" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_package_memories_package_app" ON "package_memories" USING btree ("package_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_package_memories_org_id" ON "package_memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_package_memories_app_id" ON "package_memories" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_package_id" ON "package_schedules" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_connection_profile_id" ON "package_schedules" USING btree ("connection_profile_id");--> statement-breakpoint
CREATE INDEX "idx_package_schedules_org_id" ON "package_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_package_schedules_app_id" ON "package_schedules" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_run_id" ON "run_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_lookup" ON "run_logs" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "idx_run_logs_org_id" ON "run_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_runs_package_id" ON "runs" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_runs_user_id" ON "runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_end_user_id" ON "runs" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_application_id" ON "runs" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_runs_app_status_started" ON "runs" USING btree ("application_id","status","started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_org_id" ON "runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_runs_notification" ON "runs" USING btree ("user_id","org_id","notified_at","read_at");--> statement-breakpoint
CREATE INDEX "idx_app_profile_bindings_source" ON "app_profile_provider_bindings" USING btree ("source_profile_id");--> statement-breakpoint
CREATE INDEX "idx_app_profile_bindings_user" ON "app_profile_provider_bindings" USING btree ("bound_by_user_id");--> statement-breakpoint
CREATE INDEX "idx_app_provider_creds_provider" ON "application_provider_credentials" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_app_provider_creds_app_id" ON "application_provider_credentials" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default" ON "connection_profiles" USING btree ("user_id") WHERE "connection_profiles"."is_default" = true AND "connection_profiles"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default_end_user" ON "connection_profiles" USING btree ("end_user_id") WHERE "connection_profiles"."is_default" = true AND "connection_profiles"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_user_id" ON "connection_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_end_user_id" ON "connection_profiles" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_app_id" ON "connection_profiles" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ufpp_member" ON "user_agent_provider_profiles" USING btree ("user_id","package_id","provider_id") WHERE "user_agent_provider_profiles"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ufpp_end_user" ON "user_agent_provider_profiles" USING btree ("end_user_id","package_id","provider_id") WHERE "user_agent_provider_profiles"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ufpp_package_id" ON "user_agent_provider_profiles" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_ufpp_profile_id" ON "user_agent_provider_profiles" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_provider_connections_unique" ON "user_provider_connections" USING btree ("profile_id","provider_id","org_id","provider_credential_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_profile" ON "user_provider_connections" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_profile_provider" ON "user_provider_connections" USING btree ("profile_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_org_id" ON "user_provider_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_cred_id" ON "user_provider_connections" USING btree ("provider_credential_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_org_provider" ON "user_provider_connections" USING btree ("org_id","provider_id");