CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_api_key_id" ON "credential_proxy_usage" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_user_id" ON "credential_proxy_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_credential_proxy_usage_application_id" ON "credential_proxy_usage" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "pkp_run_id" ON "package_persistence" USING btree ("run_id") WHERE "package_persistence"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_app_started" ON "runs" USING btree ("application_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_package_run_number" ON "runs" USING btree ("package_id","run_number");--> statement-breakpoint
CREATE INDEX "idx_runs_api_key_id" ON "runs" USING btree ("api_key_id") WHERE "runs"."api_key_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_model_credential_id" ON "runs" USING btree ("model_credential_id") WHERE "runs"."model_credential_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_unread" ON "runs" USING btree ("application_id","user_id") WHERE "runs"."notified_at" IS NOT NULL AND "runs"."read_at" IS NULL;