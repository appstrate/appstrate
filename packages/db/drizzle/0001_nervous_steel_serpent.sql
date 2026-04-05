CREATE TABLE "application_provider_credentials" (
	"application_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"credentials_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "application_provider_credentials_application_id_provider_id_pk" PRIMARY KEY("application_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "application_id" text;--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD CONSTRAINT "application_provider_credentials_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_provider_credentials" ADD CONSTRAINT "application_provider_credentials_provider_id_packages_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_provider_creds_provider" ON "application_provider_credentials" USING btree ("provider_id");--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;