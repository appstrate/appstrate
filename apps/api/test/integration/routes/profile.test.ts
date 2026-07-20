// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedApiKey } from "../../helpers/seed.ts";
import { user as userTable, account as accountTable } from "@appstrate/db/schema";

const app = getTestApp();

describe("Profile API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("GET /api/profile", () => {
    it("returns user profile including email", async () => {
      const res = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.user.id);
      expect(body.displayName).toBeTruthy();
      expect(body.language).toBe("fr"); // default
      // Email is the authoritative "current identity" — surfaced to the
      // CLI so `whoami` reflects dashboard-side email changes.
      expect(body.email).toBe(ctx.user.email);
      // `name` comes from BA's `user.name` column (set at signup) so
      // whoami has a fallback when the user never customized their
      // `profiles.displayName`. Kept server-authoritative for the same
      // reason as `email`.
      expect(body.name).toBe(ctx.user.name);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/profile");
      expect(res.status).toBe(401);
    });

    // Scope-independence invariant: `/api/profile` must be reachable by
    // any authenticated caller — including CLI-scope JWTs that carry
    // only `user` + `applicationId` in context (no OIDC scope claim, no
    // X-Org-Id). The CLI's `whoami` relies on this to verify its
    // session is valid without needing an org pin. This test uses the
    // session cookie (which also has no OIDC scope) to pin the
    // invariant: `/api/profile` does not require a particular scope or
    // org context to resolve.
    it("does not require an OIDC scope or X-Org-Id header", async () => {
      const res = await app.request("/api/profile", {
        // Deliberately NO X-Org-Id — cookie-only (same profile a
        // zero-scope CLI JWT observes).
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("PATCH /api/profile", () => {
    it("updates language and returns the full profile", async () => {
      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "en" }),
      });

      expect(res.status).toBe(200);
      // Bare updated resource — same serializer as GET /api/profile
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.user.id);
      expect(body.language).toBe("en");
      expect(body.email).toBe(ctx.user.email);
      expect(body.name).toBe(ctx.user.name);
      expect(body).not.toHaveProperty("ok");

      // Verify persistence
      const getRes = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      const profile = (await getRes.json()) as any;
      expect(profile.language).toBe("en");
    });

    it("updates display name and returns the full profile", async () => {
      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.user.id);
      expect(body.displayName).toBe("New Name");
      expect(body.email).toBe(ctx.user.email);
      expect(body).not.toHaveProperty("ok");

      // PATCH returns the exact same shape as GET /api/profile
      const getRes = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      expect(await getRes.json()).toEqual(body);
    });

    it("rejects invalid language", async () => {
      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "de" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/profiles/batch", () => {
    it("returns display names for org member IDs", async () => {
      const res = await app.request("/api/profiles/batch", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: [ctx.user.id] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(1);
    });

    it("does not return profiles for users outside the org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "other-org" });

      const res = await app.request("/api/profiles/batch", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: [otherCtx.user.id] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(0);
    });

    it("returns empty for unknown IDs", async () => {
      const res = await app.request("/api/profiles/batch", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: ["unknown-id"] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(0);
    });
  });

  describe("POST /api/profile/password", () => {
    // Simulate a social-sign-in-only account: createTestContext seeds a
    // `credential` account row (email/password), which a Google/GitHub
    // signup never creates — drop it so the user has no password.
    async function removeCredentialAccount(userId: string) {
      await db
        .delete(accountTable)
        .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, "credential")));
    }

    async function getCredentialAccount(userId: string) {
      const rows = await db
        .select()
        .from(accountTable)
        .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, "credential")));
      return rows[0];
    }

    it("creates the credential account for a user without a password", async () => {
      await removeCredentialAccount(ctx.user.id);

      const res = await app.request("/api/profile/password", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "NewPassword123!" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe(true);

      const account = await getCredentialAccount(ctx.user.id);
      expect(account).toBeDefined();
      expect(account!.password).toBeTruthy();
    });

    it("allows email/password sign-in after setting the password", async () => {
      await removeCredentialAccount(ctx.user.id);

      const setRes = await app.request("/api/profile/password", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "NewPassword123!" }),
      });
      expect(setRes.status).toBe(200);

      const signInRes = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ctx.user.email, password: "NewPassword123!" }),
      });
      expect(signInRes.status).toBe(200);
    });

    it("returns 409 when a password is already set", async () => {
      const res = await app.request("/api/profile/password", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "NewPassword123!" }),
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.code).toBe("password_already_set");
    });

    it("returns 400 for a password shorter than 8 characters", async () => {
      await removeCredentialAccount(ctx.user.id);

      const res = await app.request("/api/profile/password", {
        method: "POST",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "short" }),
      });

      expect(res.status).toBe(400);
      // No credential account must have been created on the failed attempt.
      expect(await getCredentialAccount(ctx.user.id)).toBeUndefined();
    });

    it("returns 403 for API key auth", async () => {
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
      });
      const res = await app.request("/api/profile/password", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ newPassword: "NewPassword123!" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/profile/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "NewPassword123!" }),
      });
      expect(res.status).toBe(401);
    });
  });

  // Issue #172 (extension) — `/api/profile` is the dashboard user's
  // identity record. PATCH mutates BA-owned `user.name`; GET leaks
  // creator PII. Customer-facing API keys must be denied on both.
  describe("API key cannot reach dashboard user profile", () => {
    it("GET /api/profile returns 403 for API key auth", async () => {
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
      });
      const res = await app.request("/api/profile", {
        headers: { Authorization: `Bearer ${apiKey.rawKey}` },
      });
      expect(res.status).toBe(403);
    });

    it("PATCH /api/profile returns 403 and does not rename the user", async () => {
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
      });
      const originalName = ctx.user.name;

      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${apiKey.rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Pwned Name" }),
      });
      expect(res.status).toBe(403);

      const [row] = await db
        .select({ name: userTable.name })
        .from(userTable)
        .where(eq(userTable.id, ctx.user.id));
      expect(row?.name).toBe(originalName);
    });
  });
});
