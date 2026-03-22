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
ALTER TABLE "execution_logs" DROP CONSTRAINT "execution_logs_user_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "idx_user_external_id";--> statement-breakpoint
DROP INDEX "idx_execution_logs_user_id";--> statement-breakpoint
DROP INDEX "idx_connection_profiles_default";--> statement-breakpoint
ALTER TABLE "user_package_profiles" DROP CONSTRAINT "user_package_profiles_user_id_package_id_pk";--> statement-breakpoint
ALTER TABLE "executions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "package_schedules" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "share_tokens" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_applications_org_id" ON "applications" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_applications_one_default" ON "applications" USING btree ("org_id") WHERE "applications"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_end_users_external_id" ON "end_users" USING btree ("application_id","external_id") WHERE "end_users"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_end_users_application_id" ON "end_users" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_end_users_org_id" ON "end_users" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD CONSTRAINT "user_package_profiles_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_executions_end_user_id" ON "executions" USING btree ("end_user_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_end_user_id" ON "package_schedules" USING btree ("end_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default_end_user" ON "connection_profiles" USING btree ("end_user_id") WHERE "connection_profiles"."is_default" = true AND "connection_profiles"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_end_user_id" ON "connection_profiles" USING btree ("end_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_package_profiles_member" ON "user_package_profiles" USING btree ("user_id","package_id") WHERE "user_package_profiles"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_package_profiles_end_user" ON "user_package_profiles" USING btree ("end_user_id","package_id") WHERE "user_package_profiles"."end_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connection_profiles_default" ON "connection_profiles" USING btree ("user_id") WHERE "connection_profiles"."is_default" = true AND "connection_profiles"."user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "external_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "execution_logs" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_exactly_one_actor" CHECK ((created_by IS NOT NULL AND end_user_id IS NULL) OR (created_by IS NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "user_package_profiles" ADD CONSTRAINT "user_package_profiles_exactly_one_actor" CHECK ((user_id IS NOT NULL AND end_user_id IS NULL) OR (user_id IS NULL AND end_user_id IS NOT NULL));