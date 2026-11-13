-- Three columns the money path needs, all additive: no rewrite, no lock beyond
-- the catalog update, no DML.
--
--   ee_billing_accounts.cancel_requested_at — an unconfirmed Stripe cancellation
--     keeps its subscription reference for the sweeper to retry
--     (src/billing/org-cancellation.ts).
--
--   ee_billing_cursor.floor_id — the cutover exclusion bound the replay window
--     may not read below (`ledgerScanStart`, src/billing/usage-recorder.ts).
--     DEFAULT 0 is exactly the behaviour a cursor that predates it has today.
--
--   ee_billed_llm_usage.pricing_status — what a claim is worth (`PricingFaults`,
--     same file). DEFAULT 'priced': every claim made earlier was billed in full.

ALTER TABLE "ee_billing_accounts" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ee_billing_cursor" ADD COLUMN "floor_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ee_billed_llm_usage" ADD COLUMN "pricing_status" text DEFAULT 'priced' NOT NULL;
