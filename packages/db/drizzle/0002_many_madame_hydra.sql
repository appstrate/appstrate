ALTER TABLE "application_provider_credentials" ALTER COLUMN "credentials_encrypted" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_states" ALTER COLUMN "application_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_connection_profile_id_connection_profiles_id_fk" FOREIGN KEY ("connection_profile_id") REFERENCES "public"."connection_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_schedule_id_package_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."package_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_application_packages_app_id" ON "application_packages" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_app_provider_creds_app_id" ON "application_provider_credentials" USING btree ("application_id");