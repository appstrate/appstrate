-- Close four open vocabularies the application already treats as closed, and
-- widen `uploads.size` to match `files.size`.
--
-- The common thread: in each case the TypeScript side already narrows the value
-- defensively on the way out of the database. A defensive narrow on a read is
-- the tell that the writer's guarantee is not written down anywhere the
-- database can enforce — the column is `text`, so a raw INSERT, a future code
-- path, or a hand-run UPDATE can put anything in it, and the read has to guess
-- what to do with the result.
--
-- ═══ 1. webhooks.payload_mode ═══
--
-- Two values. `apps/api/src/modules/webhooks/routes.ts:62,72,85` validates the
-- INPUT with `z.enum(["full", "summary"])`, and then routes.ts:254-255 and
-- service.ts:126 narrow the OUTPUT again:
--
--   payloadMode: wh.payloadMode === "full" || wh.payloadMode === "summary"
--     ? wh.payloadMode : "full"
--   payloadMode: row.payloadMode as "summary" | "full"
--
-- The first silently rewrites an unknown value to `"full"`; the second is a
-- bare cast that lies to the type system. Both exist only because the column
-- cannot promise what the Zod schema on the way in already required.
--
-- ═══ 2. webhook_deliveries.status ═══
--
-- Three values, all written by one worker (`service.ts:717,748` write
-- `"failed"` / `"success"`; the column defaults to `"pending"`). Read back at
-- `service.ts:108` as `row.status as "pending" | "success" | "failed"` — again
-- a cast, not a check.
--
-- ═══ 3. oidc_end_user_profiles.status — AND THE DECISION TO KEEP IT ═══
--
-- This one deserves its own argument, because the column looks dead. The ONLY
-- production writes are `"active"` (`modules/oidc/services/enduser-mapping.ts:279,338`),
-- and the only write of any other value in the entire repo is a test
-- (`modules/oidc/test/integration/middleware/enduser-token-auth.test.ts:349`,
-- setting `"suspended"`). By the standard this repo applied in 0044/0045 to
-- three WRITTEN-NEVER-READ columns, a column with no meaningful writer is a
-- candidate for deletion.
--
-- It is the opposite case, and the asymmetry is the point: this column has a
-- READER and no writer. `modules/oidc/auth/strategy.ts:271` rejects every
-- end-user token whose profile is not `"active"`. That gate is live, it is
-- covered by a test that exercises the suspended path end to end, and it is the
-- only lever an operator has to revoke an end-user's access WITHOUT deleting
-- the identity (deletion is the other supported revocation, per the comment
-- just below that gate). A dropped column takes the gate with it and leaves
-- deletion as the only answer to "suspend this account", which is not the same
-- product decision.
--
-- So: KEEP, and give it the CHECK — `('active', 'suspended')`, the two values
-- the reader and its test actually distinguish. The CHECK is what turns
-- "suspension is reachable by an UPDATE" from folklore into a documented
-- contract, and it rejects the typo (`'suspend'`, `'disabled'`) that would
-- otherwise silently lock an end-user out with no way to tell why.
--
-- Recorded so the next reviewer does not re-litigate it: the alternative — drop
-- the column AND its gate at `strategy.ts:271` — is coherent, but it is a
-- product change (removing suspension), not a cleanup, and it belongs to
-- whoever owns that decision.
--
-- ═══ 4. package_schedules.timezone → NOT NULL DEFAULT 'UTC' ═══
--
-- The column already has `DEFAULT 'UTC'` (`src/schema/runs.ts`), so a row can
-- only be NULL if a writer passed NULL explicitly. Three readers compensate for
-- that possibility anyway — `apps/api/src/services/scheduler.ts:154,330,992`,
-- each spelling `row.timezone ?? "UTC"`. Three copies of one default, in a
-- file where a fourth reader added tomorrow silently gets `undefined` instead.
--
-- Backfill-then-promote, never `SET NOT NULL` alone: the promotion scans the
-- table and fails on the first NULL. The UPDATE is the exact inverse of that
-- scan, and re-running it matches zero rows (same idempotency discipline as
-- 0029 step 5, which this mirrors).
--
-- ═══ 5. uploads.size integer → bigint ═══
--
-- `files.size` is `bigint` (`src/schema/files.ts:94`); `uploads.size` is
-- `integer` for the same quantity, at the other end of the same pipeline — an
-- upload is consumed INTO a file. This is not a bug today: the upload cap is
-- 100 MiB, three orders of magnitude below int4's 2 147 483 647. It becomes one
-- the day the cap is raised past ~2 GiB, and the failure is a raw Postgres
-- `22003 integer out of range` from an INSERT, surfacing as a 500 on upload
-- with nothing in the message naming the cap or the column.
--
-- Both are declared `{ mode: "number" }` in drizzle, so the TypeScript type on
-- both sides stays `number` and no reader changes. (Above 2^53 that mode would
-- lose precision — irrelevant at any plausible file size, and it is the
-- convention `files.size` already set.)
--
-- ═══ CHECKS SCAN EXISTING ROWS, DELIBERATELY ═══
--
-- Nothing here is added `NOT VALID`. Splitting `ADD CONSTRAINT … NOT VALID`
-- from a later `VALIDATE CONSTRAINT` relieves lock pressure only when the
-- halves land in DIFFERENT deploys, and the boot migrator applies every pending
-- migration inside ONE transaction — the ACCESS EXCLUSIVE is held to that
-- transaction's commit either way (0029's header makes the same argument).
--
-- So each CHECK validates against current data, and a row outside its
-- vocabulary FAILS THE DEPLOY. That is the intended behaviour, not an
-- oversight: such a row means something wrote a value the application cannot
-- interpret, and the two `as` casts above have been quietly handing it to
-- TypeScript as if it were legal. Surfacing it at deploy time is the point. On
-- current data none can fire — every value has one writer, listed above.
--
-- ═══ LOCK AND COST ═══
--
-- `ADD CONSTRAINT … CHECK` and `ALTER COLUMN … SET NOT NULL` take ACCESS
-- EXCLUSIVE and scan the table. `ALTER COLUMN … TYPE bigint` takes ACCESS
-- EXCLUSIVE and REWRITES it (int4 and int8 are different widths — this is not a
-- catalog-only change). ACCESS EXCLUSIVE conflicts with every lock mode,
-- readers included. `webhook_deliveries` is the largest table touched
-- (append-only, no retention sweep); `uploads` is GC'd and small.
--
-- Locks are held to COMMIT and drizzle commits the whole batch at once, so
-- every table here stays locked until the last migration in the batch commits.
-- Fenced with `SET LOCAL lock_timeout = '3s'`, reset to DEFAULT after — same
-- instrument as 0039/0041/0047-0050; see 0039's header for `SET LOCAL` rather
-- than `SET`. On expiry the statement errors and aborts the single transaction
-- wrapping the batch: `migrate` throws, boot fails, the deploy fails its health
-- gate. Right trade (fail fast, retry), but a failed deploy, not a silent skip.
--
-- Every statement is individually guarded (`pg_constraint` lookup,
-- `pg_attribute.attnotnull`, `IF NOT EXISTS`-equivalent), so a partially
-- applied environment converges on replay — same discipline as 0029.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhooks_payload_mode_valid'
      AND conrelid = 'public.webhooks'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_payload_mode_valid" CHECK (payload_mode IN ('full', 'summary'));
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'webhook_deliveries_status_valid'
      AND conrelid = 'public.webhook_deliveries'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_valid" CHECK (status IN ('pending', 'success', 'failed'));
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oidc_end_user_profiles_status_valid'
      AND conrelid = 'public.oidc_end_user_profiles'::regclass
      AND contype = 'c'
  ) THEN
    ALTER TABLE "oidc_end_user_profiles" ADD CONSTRAINT "oidc_end_user_profiles_status_valid" CHECK (status IN ('active', 'suspended'));
  END IF;
END $$;--> statement-breakpoint
UPDATE "package_schedules" SET "timezone" = 'UTC' WHERE "timezone" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.package_schedules'::regclass
      AND attname = 'timezone'
      AND NOT attnotnull
  ) THEN
    ALTER TABLE "package_schedules" ALTER COLUMN "timezone" SET NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "package_schedules" ALTER COLUMN "timezone" SET DEFAULT 'UTC';--> statement-breakpoint
ALTER TABLE "uploads" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
