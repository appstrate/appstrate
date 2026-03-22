DROP INDEX "idx_webhooks_org_active";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "application_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "application_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_application_id" ON "api_keys" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_application_id" ON "webhooks" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_app_active" ON "webhooks" USING btree ("application_id","active");