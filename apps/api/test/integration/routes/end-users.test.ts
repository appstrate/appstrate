// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { endUsers } from "@appstrate/db/schema";

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
        ...authHeaders(ctx),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "End-User Test Key",
        applicationId: ctx.defaultAppId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
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
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.id).toStartWith("eu_");
      expect(body.name).toBe("Alice");
      expect(body.email).toBe("alice@example.com");
    });

    it("includes Appstrate-Version response header", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Version Test" }),
      });

      expect(res.status).toBe(201);
      expect(res.headers.get("Appstrate-Version")).toBeDefined();
      expect(res.headers.get("Appstrate-Version")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "No Auth" }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects unknown top-level keys with 400 unknown_field (strict schema)", async () => {
      const res = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Strict", role: "admin" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        code?: string;
        errors?: Array<{ code?: string }>;
      };
      expect(body.code).toBe("validation_failed");
      expect(body.errors?.some((e) => e.code === "unknown_field")).toBe(true);
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
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by substring search across name/email", async () => {
      await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Zaphod Beeblebrox", email: "zaphod@example.com" }),
      });
      await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Arthur Dent", email: "arthur@example.com" }),
      });

      const res = await app.request("/api/end-users?search=zaph", {
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("Zaphod Beeblebrox");
    });

    describe("?limit", () => {
      /**
       * The spec declares `minimum: 1, maximum: 100, default: 20`
       * (`openapi/paths/end-users.ts`) and nothing used to enforce it: the route
       * coerced the param with a bare `Number()`, so `?limit=abc` produced
       * `NaN`, `??` did not catch it and neither did `Math.min(Math.max(NaN, 1),
       * 100)`. Drizzle's pg dialect emits the `limit` clause only for a
       * `number >= 0`, so the clause was DROPPED — not a 500, an unbounded query
       * returning every end-user in the application, with `limit: null` and
       * `hasMore: false` in the envelope.
       *
       * `PAGE + 1` rows exist in every case below, so a dropped clause is
       * visible in `data.length`, not just in the echoed `limit`.
       */
      const PAGE = 20;

      beforeEach(async () => {
        await db.insert(endUsers).values(
          Array.from({ length: PAGE + 1 }, (_, i) => ({
            id: `eu_limitprobe_${String(i).padStart(2, "0")}`,
            applicationId: ctx.defaultAppId,
            orgId: ctx.orgId,
            name: `Probe ${i}`,
          })),
        );
      });

      it.each([
        ["abc", "non-numeric"],
        ["-5", "below the minimum"],
        ["1e9", "above the maximum"],
      ])("falls back to the default page size for ?limit=%s (%s)", async (value) => {
        const res = await app.request(`/api/end-users?limit=${value}`, {
          headers: apiKeyHeaders(),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.limit).toBe(PAGE);
        expect(body.data).toHaveLength(PAGE);
        expect(body.hasMore).toBe(true);
      });

      it("honours a valid limit", async () => {
        const res = await app.request("/api/end-users?limit=3", {
          headers: apiKeyHeaders(),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as any;
        expect(body.limit).toBe(3);
        expect(body.data).toHaveLength(3);
        expect(body.hasMore).toBe(true);
      });
    });
  });

  describe("GET /api/end-users/:id", () => {
    it("returns a single end-user by ID", async () => {
      const createRes = await app.request("/api/end-users", {
        method: "POST",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob", email: "bob@example.com" }),
      });
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
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
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        method: "PATCH",
        headers: { ...apiKeyHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
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
      const created = (await createRes.json()) as any;

      const res = await app.request(`/api/end-users/${created.id}`, {
        method: "DELETE",
        headers: apiKeyHeaders(),
      });

      expect(res.status).toBe(204);

      // Verify it is gone from the list
      const listRes = await app.request("/api/end-users", {
        headers: apiKeyHeaders(),
      });
      const listBody = (await listRes.json()) as any;
      const found = listBody.data.find((u: { id: string }) => u.id === created.id);
      expect(found).toBeUndefined();
    });
  });
});
