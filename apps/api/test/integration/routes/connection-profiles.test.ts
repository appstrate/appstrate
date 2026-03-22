import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Connection Profiles API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });


  describe("GET /api/connection-profiles", () => {
    it("returns profiles list", async () => {
      const res = await app.request("/api/connection-profiles", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.profiles).toBeArray();
      // Default profile may or may not be created yet (fire-and-forget in auth middleware).
      // We only assert the endpoint works and returns the correct shape.
    });
  });

  describe("POST /api/connection-profiles", () => {
    it("creates a new profile", async () => {
      const res = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Work Profile" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.profile).toBeDefined();
      expect(body.profile.name).toBe("Work Profile");
    });

    it("rejects empty name", async () => {
      const res = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/connection-profiles/:id", () => {
    it("renames a profile", async () => {
      // Create profile first
      const createRes = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Old Name" }),
      });
      const { profile } = await createRes.json() as any;

      const res = await app.request(`/api/connection-profiles/${profile.id}`, {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Name" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });
  });

  describe("DELETE /api/connection-profiles/:id", () => {
    it("deletes a profile", async () => {
      const createRes = await app.request("/api/connection-profiles", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "To Delete" }),
      });
      const { profile } = await createRes.json() as any;

      const res = await app.request(`/api/connection-profiles/${profile.id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
    });
  });
});
