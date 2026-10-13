ALTER TABLE "model_provider_pairings" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "model_provider_pairings" ADD CONSTRAINT "model_provider_pairings_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
