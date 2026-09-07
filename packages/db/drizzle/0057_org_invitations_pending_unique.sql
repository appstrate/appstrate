-- One pending invitation per (organization, email).
--
-- `createInvitation` refuses a second pending row for the pair (409
-- `invitation_already_pending`); this index makes two concurrent creates safe —
-- one INSERT lands, the other raises 23505, mapped to that same 409. `email` is
-- stored lower-cased and trimmed, so a plain column index is exact. Failing here
-- rolls the whole drizzle batch back, so `scripts/migration/README.md`'s rollout
-- counts duplicate pairs first and repairs them with its `0009`.
--
-- FENCES, same instrument and values as 0056.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_invitations_pending" ON "org_invitations" USING btree ("org_id","email") WHERE "org_invitations"."status" = 'pending';--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
