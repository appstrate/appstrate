-- OIDC module: brute-force lockout counter on device codes.
--
-- Adds an `attempts` counter that the realm guard on `/device/approve`
-- (and `/device/deny`) increments on every approval attempt. At the
-- threshold (see `MAX_APPROVE_ATTEMPTS` in `auth/guards.ts`) the row
-- transitions to `status = 'denied'` so further approves — including
-- the legit user's — are refused. The legit flow requires a fresh code.
--
-- The counter covers the post-lookup part of the attack path: once a
-- user_code is known (leaked via log forwarding, shoulder surf, partial
-- disclosure via the consent page, etc.) an attacker cannot retry realm
-- mismatches indefinitely across different accounts hoping to find one
-- in the right audience. Pure guess-the-code-from-cold remains limited
-- by the per-IP rate limits on `/device/approve` + `/activate*` and by
-- the ~34.6 bits of entropy in the 20⁸ generated user-code space.

ALTER TABLE "device_codes"
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
