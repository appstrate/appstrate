-- OIDC module: org-level auto-provisioning policy.
--
-- Adds two columns on `oauth_clients` so admins can opt-in to auto-join for
-- org-level clients and pick the role assigned on first sign-in.
--
-- Defaults (`allow_signup=false`, `signup_role='member'`) preserve the
-- pre-migration behavior: non-members continue to be rejected. Admins opt in
-- from the OAuth client admin UI.
--
-- `owner` is excluded from `signup_role` on purpose: self-promotion to owner
-- through a misconfigured client is an unacceptable risk. The role allowlist
-- is mirrored in Zod (`createOrgClientSchema`) and the admin UI.
--
-- Application/instance clients ignore these columns — end-user provisioning
-- for application-level flows is handled by `resolveOrCreateEndUser`.

ALTER TABLE "oauth_clients"
  ADD COLUMN "allow_signup" boolean NOT NULL DEFAULT false,
  ADD COLUMN "signup_role" text NOT NULL DEFAULT 'member'
    CONSTRAINT "oauth_clients_signup_role_check"
    CHECK ("signup_role" IN ('admin', 'member', 'viewer'));
