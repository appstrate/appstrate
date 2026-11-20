-- Billing hardening: exact money arithmetic.
--
-- PRODUCTION DATA EXISTS: incremental and RE-RUNNABLE. The statements are
-- idempotent (re-applying the same type/default is a no-op).
--
--   * cloud_usage_records.cost_usd — double precision => numeric(24,12).

-- Exact decimal money. `cost_usd` is a CUMULATIVE total (the `unattributed`
-- bucket is one row per org that grows forever), and the sweep reconstructs the
-- pre-pass cumulative as `cost_usd - delta` to derive the credit delta. Under
-- `double precision` neither the accumulation nor that reconstruction is exact;
-- under `numeric` both are. The implicit USING conversion is lossless in the
-- only direction that matters (float8 -> numeric takes the shortest decimal
-- representation of the stored double).
ALTER TABLE "cloud_usage_records" ALTER COLUMN "cost_usd" SET DATA TYPE numeric(24, 12);--> statement-breakpoint
ALTER TABLE "cloud_usage_records" ALTER COLUMN "cost_usd" SET DEFAULT '0';
