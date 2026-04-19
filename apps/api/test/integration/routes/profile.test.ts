// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

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
    it("updates language", async () => {
      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "en" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.language).toBe("en");

      // Verify persistence
      const getRes = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });
      const profile = (await getRes.json()) as any;
      expect(profile.language).toBe("en");
    });

    it("updates display name", async () => {
      const res = await app.request("/api/profile", {
        method: "PATCH",
        headers: { Cookie: ctx.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.displayName).toBe("New Name");
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
      expect(body.profiles).toBeArray();
      expect(body.profiles).toHaveLength(1);
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
      expect(body.profiles).toHaveLength(0);
    });

    it("returns empty for unknown IDs", async () => {
      const res = await app.request("/api/profiles/batch", {
        method: "POST",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ ids: ["unknown-id"] }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.profiles).toHaveLength(0);
    });
  });
});
