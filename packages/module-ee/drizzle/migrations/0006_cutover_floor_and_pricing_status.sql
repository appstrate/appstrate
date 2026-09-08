-- Three columns the money path needs, all additive: no rewrite, no lock beyond
-- the catalog update, no DML.
--
--   ee_billing_cursor.floor_id — the settled frontier the cursor was seeded at.
--     The sweep reads from `watermark − REPLAY_WINDOW`, so without a floor that
--     read walks back below the cutover seed and bills the historical usage the
--     cutover excluded. DEFAULT 0 for a cursor that already exists: its original
--     frontier was never recorded, and 0 is exactly the behaviour it has today.
--     `ensureCursorSeeded` writes the real frontier when it seeds a new one.
--
--   ee_billed_llm_usage.pricing_status — what a claim is worth. An `unpriced`
--     ledger row (cost 0 because the platform could NOT price the call) is
--     claimed for 0 credits; the stamp is what keeps that revenue recoverable
--     instead of silently settled as free. DEFAULT 'priced' is correct for every
--     row claimed before this column existed — all of them were billed in full.
--
--   ee_billing_accounts.cancel_requested_at — set when org deletion asked Stripe
--     to cancel and is not yet sure it happened, so a failed cancellation keeps
--     its subscription reference for the sweeper to retry.

ALTER TABLE "ee_billing_accounts" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ee_billing_cursor" ADD COLUMN "floor_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ee_billed_llm_usage" ADD COLUMN "pricing_status" text DEFAULT 'priced' NOT NULL;
