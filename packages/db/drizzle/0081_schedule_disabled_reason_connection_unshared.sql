-- A later migration must not use 'connection_unshared' (DML, DEFAULT, CHECK):
-- drizzle applies every pending migration in one transaction, and Postgres
-- refuses a value added to an existing enum in the transaction that added it.
ALTER TYPE "public"."schedule_disabled_reason" ADD VALUE 'connection_unshared';
