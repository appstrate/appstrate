DROP INDEX "idx_user_provider_connections_unique";--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD CONSTRAINT "application_provider_credentials_id_unique" UNIQUE("id");--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD COLUMN "provider_credential_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "user_provider_connections" ADD CONSTRAINT "user_provider_connections_provider_credential_id_application_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."application_provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_provider_connections_cred_id" ON "user_provider_connections" USING btree ("provider_credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_provider_connections_unique" ON "user_provider_connections" USING btree ("profile_id","provider_id","org_id","provider_credential_id");
