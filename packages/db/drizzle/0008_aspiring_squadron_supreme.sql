ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_connection_profile_id_connection_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_connection_profile_id_connection_profiles_id_fk" FOREIGN KEY ("connection_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE cascade ON UPDATE no action;