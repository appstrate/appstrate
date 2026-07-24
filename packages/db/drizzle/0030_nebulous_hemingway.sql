ALTER TABLE "uploads" ADD COLUMN "end_user_id" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_end_user_id_end_users_id_fk" FOREIGN KEY ("end_user_id") REFERENCES "public"."end_users"("id") ON DELETE cascade ON UPDATE no action;
