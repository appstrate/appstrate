// SPDX-License-Identifier: Apache-2.0

// Integration tests for the platform signup gate (issue #228). Covers
// every combination of AUTH_DISABLE_SIGNUP, AUTH_ALLOWED_SIGNUP_DOMAINS,
// AUTH_PLATFORM_ADMIN_EMAILS, AUTH_BOOTSTRAP_OWNER_EMAIL, and the
// invitation override that prevents the Infisical-style invitation
// breakage when signup is locked down.
//
// Each test sets env vars through `useAuthEnv`, which rebuilds the BA
// singleton and restores the env after the suite.

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { useAuthEnv } from "../../helpers/auth-env.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedInvitation } from "../../helpers/seed.ts";

const app = getTestApp();

const setAuthEnv = useAuthEnv();

async function attemptSignup(email: string) {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!", name: "Tester" }),
  });
}

describe("Platform signup gate — issue #228", () => {
  beforeEach(async () => {
    await truncateAll();
    // Better Auth caps `/sign-up*` at 3 per 10s per IP and every request
    // here arrives from the same (absent) address, so the budget has to
    // start fresh per test or the gate under test never gets a turn.
    await flushRedis();
    setAuthEnv({
      AUTH_DISABLE_SIGNUP: undefined,
      AUTH_DISABLE_ORG_CREATION: undefined,
      AUTH_ALLOWED_SIGNUP_DOMAINS: undefined,
      AUTH_PLATFORM_ADMIN_EMAILS: undefined,
      AUTH_BOOTSTRAP_OWNER_EMAIL: undefined,
    });
  });

  describe("open mode (default)", () => {
    it("allows arbitrary signups", async () => {
      const res = await attemptSignup("anyone@somewhere.com");
      expect(res.status).toBe(200);
    });
  });

  describe("invitation never auto-verifies the email", () => {
    // SECURITY: a pending invitation is matched on email ALONE (the invite
    // token is not available at signup), so it is NOT proof of inbox ownership.
    // It overrides the signup GATE (so an invited user can register when signup
    // is locked down) but must NEVER grant emailVerified — otherwise anyone
    // could mint a verified account for any unclaimed address, and the OIDC
    // end-user adopter's `emailVerified === true` takeover guard would fall.
    it("leaves the email unverified even when a pending invitation exists", async () => {
      const ctx: TestContext = await createTestContext({ orgSlug: "verifyorg" });
      await seedInvitation({
        orgId: ctx.orgId,
        email: "invited-verify@example.com",
        invitedBy: ctx.user.id,
      });

      const res = await attemptSignup("invited-verify@example.com");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user?: { emailVerified?: boolean } };
      expect(body.user?.emailVerified).toBe(false);
    });

    it("leaves the email unverified for a non-invited signup", async () => {
      const res = await attemptSignup("solo-unverified@example.com");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user?: { emailVerified?: boolean } };
      expect(body.user?.emailVerified).toBe(false);
    });
  });

  describe("AUTH_DISABLE_SIGNUP=true", () => {
    beforeEach(() => {
      setAuthEnv({ AUTH_DISABLE_SIGNUP: "true" });
    });

    it("blocks signups with no exception", async () => {
      const res = await attemptSignup("stranger@example.com");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code ?? body.message).toBe("signup_disabled");
    });

    it("allows signup when a pending invitation exists for the same email", async () => {
      // Create the host org while signup is open so the invitation can exist.
      setAuthEnv({ AUTH_DISABLE_SIGNUP: undefined });
      const ctx: TestContext = await createTestContext({ orgSlug: "hostorg" });
      await seedInvitation({
        orgId: ctx.orgId,
        email: "invited@example.com",
        invitedBy: ctx.user.id,
      });
      // Now lock down — invitation must still let the user through.
      setAuthEnv({ AUTH_DISABLE_SIGNUP: "true" });

      const res = await attemptSignup("invited@example.com");
      expect(res.status).toBe(200);
    });

    it("does NOT allow signup for an expired invitation", async () => {
      setAuthEnv({ AUTH_DISABLE_SIGNUP: undefined });
      const ctx = await createTestContext({ orgSlug: "hostorg" });
      await seedInvitation({
        orgId: ctx.orgId,
        email: "stale@example.com",
        invitedBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000),
      });
      setAuthEnv({ AUTH_DISABLE_SIGNUP: "true" });

      const res = await attemptSignup("stale@example.com");
      expect(res.status).toBe(403);
    });

    it("does not let a platform admin address through on its name alone", async () => {
      // Same rule as the bootstrap owner below, same suite for the rows.
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_PLATFORM_ADMIN_EMAILS: "Admin@Acme.com",
      });
      const res = await attemptSignup("admin@acme.com");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("signup_disabled");
    });

    it("does not let the bootstrap owner address through on its name alone", async () => {
      // Proof of ownership is what opens this account, not the gate — the
      // rows are in `auth-bootstrap-org.test.ts`.
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      });
      const res = await attemptSignup("Owner@Acme.com");
      expect(res.status).toBe(403);
    });
  });

  describe("AUTH_ALLOWED_SIGNUP_DOMAINS", () => {
    beforeEach(() => {
      setAuthEnv({ AUTH_ALLOWED_SIGNUP_DOMAINS: "acme.com" });
    });

    it("allows signups from allowed domains", async () => {
      const res = await attemptSignup("user@acme.com");
      expect(res.status).toBe(200);
    });

    it("blocks signups from disallowed domains in open mode", async () => {
      const res = await attemptSignup("intruder@evil.com");
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code ?? body.message).toBe("signup_domain_not_allowed");
    });

    it("invitation override beats the domain allowlist (external contractor)", async () => {
      setAuthEnv({ AUTH_DISABLE_SIGNUP: undefined, AUTH_ALLOWED_SIGNUP_DOMAINS: undefined });
      const ctx = await createTestContext({ orgSlug: "hostorg2" });
      await seedInvitation({
        orgId: ctx.orgId,
        email: "contractor@external.io",
        invitedBy: ctx.user.id,
      });
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_ALLOWED_SIGNUP_DOMAINS: "acme.com",
      });

      const res = await attemptSignup("contractor@external.io");
      expect(res.status).toBe(200);
    });

    it("invitation override beats the domain allowlist when signup stays open", async () => {
      // Multi-tenant SaaS recipe: signup is OPEN but restricted to one
      // domain. An invited contractor from outside the domain must still be
      // able to complete signup — otherwise sharing an org with an external
      // collaborator silently breaks (Infisical-style breakage).
      setAuthEnv({ AUTH_DISABLE_SIGNUP: undefined, AUTH_ALLOWED_SIGNUP_DOMAINS: undefined });
      const ctx = await createTestContext({ orgSlug: "hostorg-open-domain" });
      await seedInvitation({
        orgId: ctx.orgId,
        email: "contractor-open@external.io",
        invitedBy: ctx.user.id,
      });
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: undefined,
        AUTH_ALLOWED_SIGNUP_DOMAINS: "acme.com",
      });

      const res = await attemptSignup("contractor-open@external.io");
      expect(res.status).toBe(200);
    });
  });
});
