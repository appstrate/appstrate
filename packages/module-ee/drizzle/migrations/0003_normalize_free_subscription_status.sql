-- A deleted Stripe subscription leaves the org on the free plan without an
-- attached subscription. Normalize legacy rows written with a terminal Stripe
-- status to the canonical free-tier state. Credits are deliberately untouched:
-- canceling and resubscribing must not re-grant the one-time free allowance.
UPDATE "cloud_billing_accounts"
SET
	"subscription_status" = NULL,
	"updated_at" = now()
WHERE
	"plan_id" = 'free'
	AND "stripe_subscription_id" IS NULL
	AND "subscription_status" IN ('canceled', 'incomplete_expired');
