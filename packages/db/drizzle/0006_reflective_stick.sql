ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_at_most_one_actor";--> statement-breakpoint
ALTER TABLE "connection_profiles" DROP CONSTRAINT "connection_profiles_exactly_one_actor";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_end_user_id_end_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_schedules_user_id";--> statement-breakpoint
DROP INDEX "idx_schedules_end_user_id";--> statement-breakpoint
ALTER TABLE "package_schedules" ADD COLUMN "connection_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD COLUMN "connected_by_user_id" text;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_connection_profile_id_connection_profiles_id_fk" FOREIGN KEY ("connection_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_schedules_connection_profile_id" ON "package_schedules" USING btree ("connection_profile_id");--> statement-breakpoint
CREATE INDEX "idx_connection_profiles_org_id" ON "connection_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_connected_by" ON "user_provider_connections" USING btree ("connected_by_user_id");--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP COLUMN "end_user_id";--> statement-breakpoint
ALTER TABLE "connection_profiles" ADD CONSTRAINT "connection_profiles_exactly_one_owner" CHECK ((
        (user_id IS NOT NULL AND end_user_id IS NULL AND org_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NOT NULL AND org_id IS NULL) OR
        (user_id IS NULL AND end_user_id IS NULL AND org_id IS NOT NULL)
      ));