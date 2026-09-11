-- Rename the module's seven tables (and every object Postgres named after
-- them) from the `cloud_` prefix to `ee_`.
--
-- The module moved into the monorepo as `packages/module-ee`; `cloud` names
-- nothing any more. Renames only — no column, type or constraint semantics
-- change, so this is instantaneous and needs no table rewrite. The drizzle
-- migrator runs every pending file inside ONE transaction, so a failure
-- anywhere below leaves the whole set at the old names.
--
-- `ALTER TABLE … RENAME` does not touch the names of the table's own
-- constraints and indexes, so each is renamed explicitly: after this file a
-- database migrated from `0000` has exactly the object names a database
-- created fresh from the current schema would have.

ALTER TABLE "cloud_billing_accounts" RENAME TO "ee_billing_accounts";--> statement-breakpoint
ALTER TABLE "cloud_billing_cursor" RENAME TO "ee_billing_cursor";--> statement-breakpoint
ALTER TABLE "cloud_billing_managers" RENAME TO "ee_billing_managers";--> statement-breakpoint
ALTER TABLE "cloud_billed_llm_usage" RENAME TO "ee_billed_llm_usage";--> statement-breakpoint
ALTER TABLE "cloud_free_tier_claims" RENAME TO "ee_free_tier_claims";--> statement-breakpoint
ALTER TABLE "cloud_usage_records" RENAME TO "ee_usage_records";--> statement-breakpoint
ALTER TABLE "cloud_stripe_events" RENAME TO "ee_stripe_events";--> statement-breakpoint

ALTER INDEX "idx_cloud_billing_stripe_customer" RENAME TO "idx_ee_billing_stripe_customer";--> statement-breakpoint
ALTER INDEX "idx_cloud_billing_stripe_subscription" RENAME TO "idx_ee_billing_stripe_subscription";--> statement-breakpoint
ALTER INDEX "uq_cloud_usage_records_context" RENAME TO "uq_ee_usage_records_context";--> statement-breakpoint
ALTER INDEX "idx_cloud_usage_records_org_id" RENAME TO "idx_ee_usage_records_org_id";--> statement-breakpoint
ALTER INDEX "idx_cloud_usage_records_created_at" RENAME TO "idx_ee_usage_records_created_at";--> statement-breakpoint

ALTER TABLE "ee_billing_cursor" RENAME CONSTRAINT "cloud_billing_cursor_single_row" TO "ee_billing_cursor_single_row";--> statement-breakpoint
ALTER TABLE "ee_billing_managers" RENAME CONSTRAINT "cloud_billing_managers_org_id_user_id_pk" TO "ee_billing_managers_org_id_user_id_pk";--> statement-breakpoint

-- Primary keys Postgres named itself, `<table>_pkey`, from the table name each
-- was declared on.
ALTER TABLE "ee_billing_accounts" RENAME CONSTRAINT "cloud_billing_accounts_pkey" TO "ee_billing_accounts_pkey";--> statement-breakpoint
ALTER TABLE "ee_billing_cursor" RENAME CONSTRAINT "cloud_billing_cursor_pkey" TO "ee_billing_cursor_pkey";--> statement-breakpoint
ALTER TABLE "ee_billed_llm_usage" RENAME CONSTRAINT "cloud_billed_llm_usage_pkey" TO "ee_billed_llm_usage_pkey";--> statement-breakpoint
ALTER TABLE "ee_free_tier_claims" RENAME CONSTRAINT "cloud_free_tier_claims_pkey" TO "ee_free_tier_claims_pkey";--> statement-breakpoint
ALTER TABLE "ee_usage_records" RENAME CONSTRAINT "cloud_usage_records_pkey" TO "ee_usage_records_pkey";--> statement-breakpoint
ALTER TABLE "ee_stripe_events" RENAME CONSTRAINT "cloud_stripe_events_pkey" TO "ee_stripe_events_pkey";
