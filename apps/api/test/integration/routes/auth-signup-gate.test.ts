// SPDX-License-Identifier: Apache-2.0

// Integration tests for the platform signup gate (issue #228). Covers
// every combination of AUTH_DISABLE_SIGNUP, AUTH_ALLOWED_SIGNUP_DOMAINS,
// AUTH_PLATFORM_ADMIN_EMAILS, AUTH_BOOTSTRAP_OWNER_EMAIL, and the
// invitation override that prevents the Infisical-style invitation
// breakage when signup is locked down.
//
// Each test mutates env vars + rebuilds the BA singleton via the
// existing `_rebuildAuthForTesting()` test hook (this is exactly what
// the SMTP/social tests already do). After the suite, env is restored
// so the next file boots clean.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedInvitation } from "../../helpers/seed.ts";

const app = getTestApp();

const SNAPSHOT = {
  AUTH_DISABLE_SIGNUP: process.env.AUTH_DISABLE_SIGNUP,
  AUTH_DISABLE_ORG_CREATION: process.env.AUTH_DISABLE_ORG_CREATION,
  AUTH_ALLOWED_SIGNUP_DOMAINS: process.env.AUTH_ALLOWED_SIGNUP_DOMAINS,
  AUTH_PLATFORM_ADMIN_EMAILS: process.env.AUTH_PLATFORM_ADMIN_EMAILS,
  AUTH_BOOTSTRAP_OWNER_EMAIL: process.env.AUTH_BOOTSTRAP_OWNER_EMAIL,
};

function setAuthEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
}

function restore() {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
}

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
    setAuthEnv({
      AUTH_DISABLE_SIGNUP: undefined,
      AUTH_DISABLE_ORG_CREATION: undefined,
      AUTH_ALLOWED_SIGNUP_DOMAINS: undefined,
      AUTH_PLATFORM_ADMIN_EMAILS: undefined,
      AUTH_BOOTSTRAP_OWNER_EMAIL: undefined,
    });
  });

  afterAll(() => {
    restore();
  });

  describe("open mode (default)", () => {
    it("allows arbitrary signups", async () => {
      const res = await attemptSignup("anyone@somewhere.com");
      expect(res.status).toBe(200);
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

    it("allows signup for a platform admin email", async () => {
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_PLATFORM_ADMIN_EMAILS: "Admin@Acme.com",
      });
      const res = await attemptSignup("admin@acme.com");
      expect(res.status).toBe(200);
    });

    it("allows signup for the bootstrap owner email", async () => {
      setAuthEnv({
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      });
      const res = await attemptSignup("Owner@Acme.com");
      expect(res.status).toBe(200);
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
  });
});
