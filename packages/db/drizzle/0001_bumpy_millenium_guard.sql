CREATE TABLE "org_provider_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"api" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "org_models" ADD COLUMN "provider_key_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_provider_keys" ADD CONSTRAINT "org_provider_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_provider_keys_org_id" ON "org_provider_keys" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "org_models" ADD CONSTRAINT "org_models_provider_key_id_org_provider_keys_id_fk" FOREIGN KEY ("provider_key_id") REFERENCES "public"."org_provider_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_models" DROP COLUMN "api_key_encrypted";