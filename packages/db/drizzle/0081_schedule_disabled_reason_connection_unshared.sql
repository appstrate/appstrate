-- Not used by any statement here: drizzle applies the pending batch in one
-- transaction, and Postgres rejects a value added to an existing enum being
-- used in the transaction that added it.
ALTER TYPE "public"."schedule_disabled_reason" ADD VALUE 'connection_unshared';
