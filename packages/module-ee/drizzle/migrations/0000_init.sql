CREATE TABLE "cloud_billing_accounts" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"plan_id" text DEFAULT 'free' NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"credit_quota" integer DEFAULT 0 NOT NULL,
	"period_end" timestamp with time zone,
	"subscription_status" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_billed_llm_usage" (
	"llm_usage_id" integer PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"billed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_pending_bills" (
	"run_id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"model_source" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_free_tier_claims" (
	"email" text PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"cost_credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cloud_billing_stripe_customer" ON "cloud_billing_accounts" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cloud_billing_stripe_subscription" ON "cloud_billing_accounts" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_billed_llm_usage_run_id" ON "cloud_billed_llm_usage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_pending_bills_next_retry" ON "cloud_pending_bills" USING btree ("next_retry_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_usage_records_run_id" ON "cloud_usage_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_usage_records_org_id" ON "cloud_usage_records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_usage_records_created_at" ON "cloud_usage_records" USING btree ("created_at");