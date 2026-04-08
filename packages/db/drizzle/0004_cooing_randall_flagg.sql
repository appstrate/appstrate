ALTER TABLE "end_users" ADD COLUMN "auth_user_id" text;--> statement-breakpoint
ALTER TABLE "end_users" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "end_users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "end_users" ADD CONSTRAINT "end_users_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_end_users_app_auth_user" ON "end_users" USING btree ("application_id","auth_user_id") WHERE "end_users"."auth_user_id" IS NOT NULL;