CREATE INDEX "idx_packages_org_type" ON "packages" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_runs_app_status_started" ON "runs" USING btree ("application_id","status","started_at");--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_profile_provider" ON "user_provider_connections" USING btree ("profile_id","provider_id");