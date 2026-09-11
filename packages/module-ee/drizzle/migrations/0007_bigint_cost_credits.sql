-- Widen `ee_usage_records.cost_credits` from integer to bigint — see the column
-- note in drizzle/schema.ts. No DML; re-applying the same type is a no-op.
ALTER TABLE "ee_usage_records" ALTER COLUMN "cost_credits" SET DATA TYPE bigint;
