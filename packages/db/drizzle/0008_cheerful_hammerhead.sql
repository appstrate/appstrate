ALTER TABLE "cli_refresh_tokens" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "device_codes" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "cli_refresh_tokens" ADD CONSTRAINT "cli_refresh_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;