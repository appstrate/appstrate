CREATE TYPE "public"."auth_mode" AS ENUM('oauth2', 'api_key', 'basic', 'custom');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('pending', 'running', 'success', 'failed', 'timeout', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
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
	"flow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "execution_status" DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"result" jsonb,
	"state" jsonb,
	"error" text,
	"tokens_used" integer,
	"token_usage" jsonb,
	"cost_usd" numeric(10, 6),
	"started_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"duration" integer,
	"schedule_id" text,
	"flow_version_id" integer
);
--> statement-breakpoint
CREATE TABLE "flow_admin_connections" (
	"flow_id" text NOT NULL,
	"service_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"admin_user_id" text NOT NULL,
	"connected_at" timestamp DEFAULT now(),
	CONSTRAINT "flow_admin_connections_flow_id_service_id_pk" PRIMARY KEY("flow_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "flow_configs" (
	"org_id" uuid NOT NULL,
	"flow_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "flow_configs_org_id_flow_id_pk" PRIMARY KEY("org_id","flow_id")
);
--> statement-breakpoint
CREATE TABLE "flow_extensions" (
	"flow_id" text NOT NULL,
	"extension_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "flow_extensions_flow_id_extension_id_pk" PRIMARY KEY("flow_id","extension_id")
);
--> statement-breakpoint
CREATE TABLE "flow_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
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
CREATE TABLE "flow_skills" (
	"flow_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "flow_skills_flow_id_skill_id_pk" PRIMARY KEY("flow_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "flow_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"manifest" jsonb NOT NULL,
	"prompt" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "flows_id_slug" CHECK ("flows"."id" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"scopes_requested" text[] DEFAULT '{}'::text[],
	"redirect_uri" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp DEFAULT NOW() + INTERVAL '10 minutes' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_extensions" (
	"id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text,
	"description" text,
	"content" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "org_extensions_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "org_skills" (
	"id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text,
	"description" text,
	"content" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "org_skills_org_id_id_pk" PRIMARY KEY("org_id","id")
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
CREATE TABLE "provider_configs" (
	"id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"auth_mode" "auth_mode" NOT NULL,
	"display_name" text NOT NULL,
	"client_id_encrypted" text,
	"client_secret_encrypted" text,
	"authorization_url" text,
	"token_url" text,
	"refresh_url" text,
	"default_scopes" text[] DEFAULT '{}'::text[],
	"scope_separator" text DEFAULT ' ',
	"pkce_enabled" boolean DEFAULT true,
	"authorization_params" jsonb DEFAULT '{}'::jsonb,
	"token_params" jsonb DEFAULT '{}'::jsonb,
	"credential_schema" jsonb,
	"credential_field_name" text,
	"credential_header_name" text,
	"credential_header_prefix" text,
	"available_scopes" jsonb DEFAULT '[]'::jsonb,
	"authorized_uris" text[] DEFAULT '{}'::text[],
	"allow_all_uris" boolean DEFAULT false,
	"icon_url" text,
	"categories" text[] DEFAULT '{}'::text[],
	"docs_url" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "provider_configs_org_id_id_pk" PRIMARY KEY("org_id","id")
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
CREATE TABLE "service_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"flow_id" text,
	"auth_mode" "auth_mode" NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"scopes_granted" text[] DEFAULT '{}'::text[],
	"expires_at" timestamp,
	"raw_token_response" jsonb,
	"connection_config" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
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
CREATE TABLE "share_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"flow_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"execution_id" text,
	"consumed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "share_tokens_token_unique" UNIQUE("token")
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
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_logs" ADD CONSTRAINT "execution_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_flow_version_id_flow_versions_id_fk" FOREIGN KEY ("flow_version_id") REFERENCES "public"."flow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_admin_connections" ADD CONSTRAINT "flow_admin_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_admin_connections" ADD CONSTRAINT "flow_admin_connections_admin_user_id_user_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_configs" ADD CONSTRAINT "flow_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_extensions" ADD CONSTRAINT "flow_extensions_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_schedules" ADD CONSTRAINT "flow_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_schedules" ADD CONSTRAINT "flow_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_skills" ADD CONSTRAINT "flow_skills_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_versions" ADD CONSTRAINT "flow_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_extensions" ADD CONSTRAINT "org_extensions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_skills" ADD CONSTRAINT "org_skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_skills" ADD CONSTRAINT "org_skills_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_flow_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."flow_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_execution_logs_execution_id" ON "execution_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_lookup" ON "execution_logs" USING btree ("execution_id","id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_user_id" ON "execution_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_execution_logs_org_id" ON "execution_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_executions_flow_id" ON "executions" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_executions_status" ON "executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_executions_user_id" ON "executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_executions_org_id" ON "executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_flow_admin_connections_flow_id" ON "flow_admin_connections" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_flow_admin_connections_org_id" ON "flow_admin_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_flow_configs_org_id" ON "flow_configs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_flow_extensions_org_ext" ON "flow_extensions" USING btree ("org_id","extension_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_flow_id" ON "flow_schedules" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_user_id" ON "flow_schedules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_flow_schedules_org_id" ON "flow_schedules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_flow_skills_org_skill" ON "flow_skills" USING btree ("org_id","skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_versions_flow_version_unique" ON "flow_versions" USING btree ("flow_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_flow_versions_flow_id" ON "flow_versions" USING btree ("flow_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_flows_org_id" ON "flows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_states_expires" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_organization_members_user_id" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_unique" ON "schedule_runs" USING btree ("schedule_id","fire_time");--> statement-breakpoint
CREATE INDEX "idx_schedule_runs_created_at" ON "schedule_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_connections_unique" ON "service_connections" USING btree ("org_id","user_id","provider_id",COALESCE("flow_id", '__global__'));--> statement-breakpoint
CREATE INDEX "idx_service_connections_org_user" ON "service_connections" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_service_connections_provider" ON "service_connections" USING btree ("org_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_token" ON "share_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_flow_id" ON "share_tokens" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_share_tokens_org_id" ON "share_tokens" USING btree ("org_id");