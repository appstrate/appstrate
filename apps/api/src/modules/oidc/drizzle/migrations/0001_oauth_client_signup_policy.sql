-- OIDC module: unified signup opt-in policy (all client levels).
--
-- Adds two columns on `oauth_clients`:
--   - `allow_signup` — honored on every level (instance / org / application).
--     Unified semantic matches Auth0 "Disable Sign-Ups" / Keycloak "User
--     Registration" / Okta JIT toggle. Secure-by-default (`false`): unknown
--     users / end-users are rejected until explicitly opted in.
--   - `signup_role` — role assigned on auto-join (org-level only; ignored on
--     instance/application).
--
-- `owner` is excluded from `signup_role` on purpose: self-promotion to owner
-- through a misconfigured client is an unacceptable risk. The role allowlist
-- is mirrored in Zod (`createOrgClientSchema`) and the admin UI.

ALTER TABLE "oauth_clients"
  ADD COLUMN "allow_signup" boolean NOT NULL DEFAULT false,
  ADD COLUMN "signup_role" text NOT NULL DEFAULT 'member'
    CONSTRAINT "oauth_clients_signup_role_check"
    CHECK ("signup_role" IN ('admin', 'member', 'viewer'));
