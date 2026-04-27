-- Dual-signature webhook secret rotation window.
--
-- During the window between `rotate` and `secret_next_expires_at`, every
-- outbound delivery is signed with BOTH the old (`secret`) and new
-- (`secret_next`) keys, emitted as a space-separated `webhook-signature`
-- header per the Standard Webhooks multi-signature spec. After the
-- window expires, the delivery worker promotes `secret_next` → `secret`
-- inline on the next delivery and clears both new columns.
--
-- Idempotent: `ADD COLUMN IF NOT EXISTS` so the migration runner replays
-- cleanly in dev environments where state is reused across runs.

ALTER TABLE "webhooks"
  ADD COLUMN IF NOT EXISTS "secret_next" text;

ALTER TABLE "webhooks"
  ADD COLUMN IF NOT EXISTS "secret_next_expires_at" timestamp;
