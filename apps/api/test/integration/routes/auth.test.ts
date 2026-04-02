// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestUser, createTestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("Authentication", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("unauthenticated requests", () => {
    it("returns 401 for /api/agents without session", async () => {
      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid cookie", async () => {
      const res = await app.request("/api/agents", {
        headers: { Cookie: "better-auth.session_token=invalid-token" },
      });
      expect(res.status).toBe(401);
    });

    it("allows health check without auth", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });
  });

  describe("session authentication", () => {
    it("accepts valid session cookie", async () => {
      const ctx = await createTestContext();

      const res = await app.request("/api/agents", {
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
        },
      });

      expect(res.status).toBe(200);
    });

    it("requires X-Org-Id for org-scoped routes", async () => {
      const testUser = await createTestUser();

      const res = await app.request("/api/agents", {
        headers: { Cookie: testUser.cookie },
      });

      // Should fail with 400 (missing X-Org-Id)
      expect(res.status).toBe(400);
    });

    it("rejects non-member org access", async () => {
      const ctx1 = await createTestContext();
      const ctx2 = await createTestContext();

      // User 1 tries to access User 2's org
      const res = await app.request("/api/agents", {
        headers: {
          Cookie: ctx1.cookie,
          "X-Org-Id": ctx2.orgId,
        },
      });

      expect(res.status).toBe(403);
    });
  });

  describe("sign-up flow", () => {
    it("creates user via Better Auth sign-up", async () => {
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "new@test.com",
          password: "TestPassword123!",
          name: "New User",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.user.email).toBe("new@test.com");
      expect(body.user.name).toBe("New User");

      // Session cookie should be set
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("better-auth.session_token");
    });
  });
});
