// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";

const app = getTestApp();

describe("Profile API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  describe("GET /api/profile", () => {
    it("returns user profile", async () => {
      const res = await app.request("/api/profile", {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(ctx.user.id);
      expect(body.displayName).toBeTruthy();
      expect(body.language).toBe("fr"); // default
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/profile");
      expect(res.status).toBe(401);
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
