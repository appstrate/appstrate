import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("End-Users API", () => {
  let ctx: TestContext;
  let apiKeyRaw: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });

    // Create an API key via the real endpoint (cookie auth)
    const res = await app.request("/api/api-keys", {
      method: "POST",
      headers: {
        Cookie: ctx.cookie,
        "X-Org-Id": ctx.orgId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "End-User Test Key",
        applicationId: ctx.defaultAppId,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    apiKeyRaw = body.key;
  });

  function apiKeyHeaders(extra?: Record<string, string>) {
    return { Authorization: `Bearer ${apiKeyRaw}`, ...extra };
  }

  describe("POST /api/end-users", () => {
    it("creates an end-user with name and email", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeDefined();
      expect(body.id).toStartWith("eu_");
      expect(body.name).toBe("Alice");
      expect(body.email).toBe("alice@example.com");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Auth" }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/end-users", () => {
    it("lists end-users", async () => {
      // Create two end-users
      await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "User A", email: "a@example.com" }),
      });
      await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "User B", email: "b@example.com" }),
      });

      const res = await app.request("/api/end-users", {
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("GET /api/end-users/:id", () => {
    it("returns a single end-user by ID", async () => {
      const createRes = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob", email: "bob@example.com" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(created.id);
      expect(body.name).toBe("Bob");
    });
  });

  describe("PATCH /api/end-users/:id", () => {
    it("updates end-user name", async () => {
      const createRes = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Original", email: "orig@example.com" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        method: "PATCH",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.name).toBe("Updated");
    });
  });

  describe("DELETE /api/end-users/:id", () => {
    it("deletes an end-user and returns 204", async () => {
      const createRes = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "To Delete" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        method: "DELETE",
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(204);

      // Verify it is gone from the list
      const listRes = await app.request("/api/end-users", {
        headers: apiKeyHeaders(),
      });
      const listBody = await listRes.json() as any;
      const found = listBody.data.find(
        (u: { id: string }) => u.id === created.id,
      );
      expect(found).toBeUndefined();
    });
  });
});
