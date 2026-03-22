ALTER TABLE "executions" DROP CONSTRAINT "executions_exactly_one_actor";--> statement-breakpoint
ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_exactly_one_actor";--> statement-breakpoint
ALTER TABLE "share_tokens" DROP CONSTRAINT "share_tokens_exactly_one_actor";--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "executions" DROP CONSTRAINT "executions_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "executions" DROP CONSTRAINT "executions_end_user_id_end_users_id_fk";
--> statement-breakpoint
ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "package_schedules" DROP CONSTRAINT "package_schedules_end_user_id_end_users_id_fk";
--> statement-breakpoint
ALTER TABLE "share_tokens" DROP CONSTRAINT "share_tokens_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "share_tokens" DROP CONSTRAINT "share_tokens_end_user_id_end_users_id_fk";
--> statement-breakpoint
DROP INDEX "idx_api_keys_key_hash";--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_end_users_app_email" ON "end_users" USING btree ("application_id","email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_executions_application_id" ON "executions" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_at_most_one_actor" CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "package_schedules" ADD CONSTRAINT "package_schedules_at_most_one_actor" CHECK (NOT (user_id IS NOT NULL AND end_user_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_at_most_one_actor" CHECK (NOT (created_by IS NOT NULL AND end_user_id IS NOT NULL));