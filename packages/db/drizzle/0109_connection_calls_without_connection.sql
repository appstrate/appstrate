-- `connection_calls.connection_id` becomes nullable: the journal also records the calls toward an
-- integration that binds no connection (unauthenticated, AFPS §7.2), with `connection_id` and
-- `owner_*` NULL.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). Existing rows keep their connection.
--
-- ROLLBACK: a previous build reads `connection_id` as non-null and would serialize a NULL row
-- against its own contract. Delete the rows with a NULL `connection_id`, then restore the
-- constraint, or roll forward.

ALTER TABLE "connection_calls" ALTER COLUMN "connection_id" DROP NOT NULL;
