CREATE TABLE "cloud_billing_managers" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_billing_managers_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "cloud_billing_accounts" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "cloud_billing_accounts" ADD COLUMN "billing_cc" text[] DEFAULT '{}' NOT NULL;