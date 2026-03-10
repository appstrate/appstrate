CREATE TYPE "public"."execution_status" AS ENUM('pending', 'running', 'success', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."package_source" AS ENUM('local', 'system');--> statement-breakpoint
CREATE TYPE "public"."package_type" AS ENUM('flow', 'skill', 'extension', 'provider');--> statement-breakpoint
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
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[],
	"created_by" text,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "org_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"email" text NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'member' NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by" text,
	"accepted_by" text,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "org_invitations_token_unique" UNIQUE("token")
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
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now(),
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"language" text DEFAULT 'fr' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "language_check" CHECK ("profiles"."language" IN ('fr', 'en'))
);
--> statement-breakpoint
CREATE TABLE "package_configs" (
	"org_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "package_configs_org_id_package_id_pk" PRIMARY KEY("org_id","package_id")
);
--> statement-breakpoint
CREATE TABLE "package_dependencies" (
	"package_id" text NOT NULL,
	"dependency_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "package_dependencies_package_id_dependency_id_pk" PRIMARY KEY("package_id","dependency_id")
);
--> statement-breakpoint
CREATE TABLE "package_dist_tags" (
	"package_id" text NOT NULL,
	"tag" text NOT NULL,
	"version_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now(),
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
	"org_id" uuid,
	"yanked" boolean DEFAULT false NOT NULL,
	"yanked_reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now()
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
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"version" integer DEFAULT 1 NOT NULL,
	"forked_from" text,
	CONSTRAINT "packages_id_format" CHECK ("packages"."id" ~ '^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$')
);
--> statement-breakpoint
CREATE TABLE "execution_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"execution_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text DEFAULT 'progress' NOT NULL,
	"event" text,
	"message" text,
	"data" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"state" jsonb,
	"error" text,
	"tokens_used" integer,
	"token_usage" jsonb,
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"duration" integer,
	"connection_profile_id" uuid,
	"schedule_id" text,
	"package_version_id" integer,
	"notified_at" timestamp,
	"read_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "package_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"content" text NOT NULL,
	"execution_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "package_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text,
	"enabled" boolean DEFAULT true,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC',
	"input" jsonb,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"fire_time" timestamp NOT NULL,
	"execution_id" text,
	"instance_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"package_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"execution_id" text,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "share_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "connection_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"oauth_token_secret" text,
	"auth_mode" text DEFAULT 'oauth2' NOT NULL,
	"scopes_requested" text[] DEFAULT '{}'::text[],
	"redirect_uri" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp DEFAULT NOW() + INTERVAL '10 minutes' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_admin_connections" (
	"package_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid,
	"connected_at" timestamp DEFAULT now(),
	CONSTRAINT "package_admin_connections_package_id_provider_id_pk" PRIMARY KEY("package_id","provider_id")
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"provider_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"credentials_encrypted" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "provider_credentials_provider_id_org_id_pk" PRIMARY KEY("provider_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "registry_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"registry_username" text NOT NULL,
	"registry_user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "service_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"scopes_granted" text[] DEFAULT '{}'::text[],
	"expires_at" timestamp,
	"raw_token_response" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_package_profiles" (
	"user_id" text NOT NULL,
	"package_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_package_profiles_user_id_package_id_pk" PRIMARY KEY("user_id","package_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_proxies" ADD CONSTRAINT "org_proxies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_proxies" ADD CONSTRAINT "org_proxies_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_configs" ADD CONSTRAINT "package_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dependencies" ADD CONSTRAINT "package_dependencies_dependency_id_packages_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_dist_tags" ADD CONSTRAINT "package_dist_tags_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_version_dependencies" ADD CONSTRAINT "package_version_dependencies_version_id_package_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."package_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_versions" ADD CONSTRAINT "package_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_package_version_id_package_versions_id_fk" FOREIGN KEY ("package_version_id") REFERENCES "public"."package_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_memories" ADD CONSTRAINT "package_memories_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_package_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."package_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_admin_connections" ADD CONSTRAINT "package_admin_connections_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_admin_connections" ADD CONSTRAINT "package_admin_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_admin_connections" ADD CONSTRAINT "package_admin_connections_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_packages_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registry_connections" ADD CONSTRAINT "registry_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD CONSTRAINT "user_package_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD CONSTRAINT "user_package_profiles_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD CONSTRAINT "user_package_profiles_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_org_id" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_key_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_token" ON "org_invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_org_id" ON "org_invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_invitations_email" ON "org_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_org_proxies_org_id" ON "org_proxies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_organization_members_user_id" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_package_configs_org_id" ON "package_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_package_dependencies_dep_id" ON "package_dependencies" USING btree ("dependency_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pkg_ver_deps_unique" ON "package_version_dependencies" USING btree ("version_id","dep_scope","dep_name","dep_type");--> statement-breakpoint
CREATE INDEX "idx_pkg_ver_deps_version_id" ON "package_version_dependencies" USING btree ("version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_versions_pkg_version_unique" ON "package_versions" USING btree ("package_id","version");--> statement-breakpoint
CREATE INDEX "idx_package_versions_package_id" ON "package_versions" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_packages_org_id" ON "packages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_packages_type" ON "packages" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_execution_id" ON "execution_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_lookup" ON "execution_logs" USING btree ("execution_id","id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_user_id" ON "execution_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_org_id" ON "execution_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_executions_package_id" ON "executions" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_executions_status" ON "executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_executions_user_id" ON "executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_executions_org_id" ON "executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_executions_notification" ON "executions" USING btree ("user_id","org_id","notified_at","read_at");--> statement-breakpoint
CREATE INDEX "idx_package_memories_package_org" ON "package_memories" USING btree ("package_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_package_memories_org_id" ON "package_memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_package_id" ON "package_schedules" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_user_id" ON "package_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_package_schedules_org_id" ON "package_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_unique" ON "schedule_runs" USING btree ("schedule_id","fire_time");--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_created_at" ON "schedule_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_token" ON "share_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_package_id" ON "share_tokens" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_org_id" ON "share_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default" ON "connection_profiles" USING btree ("user_id") WHERE "connection_profiles"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_user_id" ON "connection_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_states_expires" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_package_admin_connections_package_id" ON "package_admin_connections" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_package_admin_connections_org_id" ON "package_admin_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_registry_connections_user_id" ON "registry_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_connections_unique" ON "service_connections" USING btree ("profile_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_service_connections_profile" ON "service_connections" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_user_package_profiles_package_id" ON "user_package_profiles" USING btree ("package_id");