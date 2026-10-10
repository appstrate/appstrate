-- The UPDATE is the precondition of `provider_id`'s SET NOT NULL on the same table
-- (docs/NO_TRANSITIONAL_CODE.md §2). Subscriptions become personal in scripts/migration/0042.
ALTER TABLE "model_provider_credentials" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "model_provider_credentials" ADD CONSTRAINT "model_provider_credentials_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_model_provider_credentials_owner" ON "model_provider_credentials" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "provider_id" text;--> statement-breakpoint
UPDATE "org_models" m SET "provider_id" = c."provider_id" FROM "model_provider_credentials" c WHERE c."id" = m."credential_id";--> statement-breakpoint
ALTER TABLE "org_models" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "org_models" ALTER COLUMN "credential_id" DROP NOT NULL;
