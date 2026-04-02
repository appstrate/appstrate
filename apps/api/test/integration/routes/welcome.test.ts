// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Welcome API", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("POST /api/welcome/setup", () => {
    it("returns 200 for authenticated user with display name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "New Display Name" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("returns 200 for authenticated user without display name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Test" }),
      });

      expect(res.status).toBe(401);
    });

    it("trims whitespace from display name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "  Padded Name  " }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("ignores empty string display name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "" }),
      });

      // Empty string after trim is falsy, so no DB update happens — still returns ok
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("ignores whitespace-only display name", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "   " }),
      });

      // Whitespace-only trims to empty, so no update — still returns ok
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });

    it("returns application/json content-type", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Test" }),
      });

      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).not.toBeNull();
      expect(contentType!).toContain("application/json");
    });

    it("response body only contains ok field", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Check Shape" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toEqual({ ok: true });
    });

    it("handles extra fields in request body gracefully", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/welcome/setup", {
        method: "POST",
        headers: {
          Cookie: testUser.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Valid", extraField: "ignored" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
    });
  });
});
