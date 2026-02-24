CREATE TABLE "connection_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_flow_profiles" (
	"user_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_flow_profiles_user_id_flow_id_pk" PRIMARY KEY("user_id","flow_id")
);
--> statement-breakpoint
ALTER TABLE "flow_admin_connections" DROP CONSTRAINT "flow_admin_connections_admin_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "service_connections" DROP CONSTRAINT "service_connections_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "service_connections" DROP CONSTRAINT "service_connections_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_service_connections_org_user";--> statement-breakpoint
DROP INDEX "idx_service_connections_provider";--> statement-breakpoint
DROP INDEX "idx_service_connections_unique";--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "connection_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_admin_connections" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "service_connections" ADD COLUMN "profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "service_connections" ADD COLUMN "provider_snapshot" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_connections" ADD COLUMN "config_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_flow_profiles" ADD CONSTRAINT "user_flow_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_flow_profiles" ADD CONSTRAINT "user_flow_profiles_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default" ON "connection_profiles" USING btree ("user_id") WHERE "connection_profiles"."is_default" = true;--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_user_id" ON "connection_profiles" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "flow_admin_connections" ADD CONSTRAINT "flow_admin_connections_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_connections" ADD CONSTRAINT "service_connections_profile_id_connection_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_service_connections_profile" ON "service_connections" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_service_connections_unique" ON "service_connections" USING btree ("profile_id","provider_id");--> statement-breakpoint
ALTER TABLE "flow_admin_connections" DROP COLUMN "admin_user_id";--> statement-breakpoint
ALTER TABLE "service_connections" DROP COLUMN "org_id";--> statement-breakpoint
ALTER TABLE "service_connections" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "service_connections" DROP COLUMN "flow_id";--> statement-breakpoint
ALTER TABLE "service_connections" DROP COLUMN "connection_config";