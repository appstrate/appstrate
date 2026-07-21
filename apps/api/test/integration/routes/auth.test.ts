// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestContext, authHeaders } from "../../helpers/auth.ts";
import { account as accountTable, session as sessionTable } from "@appstrate/db/schema";

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
        headers: authHeaders(ctx),
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

  // `session.freshAge` (packages/db/src/auth.ts) keeps Better Auth's 24h
  // freshness gate ON for sensitive endpoints (unlink-account, delete-user).
  // A session older than 24h must re-authenticate ("sudo mode" step-up): BA
  // returns 403 SESSION_NOT_FRESH, which the SPA catches to walk the user
  // through a fresh re-login before retrying the action (see
  // apps/web/src/pages/preferences/security.tsx). These tests pin that
  // contract — the 403 + `SESSION_NOT_FRESH` code the frontend relies on —
  // and confirm a fresh session still unlinks while BA's last-account guard
  // stays intact.
  describe("unlink-account session freshness (step-up)", () => {
    it("blocks unlink with a stale session (403 SESSION_NOT_FRESH)", async () => {
      const testUser = await createTestUser();

      // Link a second (social) account so the credential one isn't the last —
      // this isolates the freshness gate as the only reason for a rejection.
      await db.insert(accountTable).values({
        id: crypto.randomUUID(),
        accountId: "google-account-id",
        providerId: "google",
        userId: testUser.id,
      });

      // Age the session past BA's 24h freshAge.
      await db
        .update(sessionTable)
        .set({ createdAt: new Date(Date.now() - 1000 * 60 * 60 * 48) })
        .where(eq(sessionTable.userId, testUser.id));

      const res = await app.request("/api/auth/unlink-account", {
        method: "POST",
        headers: { Cookie: testUser.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "google" }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("SESSION_NOT_FRESH");

      // The social account row is untouched — nothing was unlinked.
      const remaining = await db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, testUser.id));
      expect(remaining.map((a) => a.providerId).sort()).toEqual(["credential", "google"]);
    });

    it("unlinks a social account with a fresh session", async () => {
      const testUser = await createTestUser();

      // Link a second (social) account so the credential one isn't the last.
      await db.insert(accountTable).values({
        id: crypto.randomUUID(),
        accountId: "google-account-id",
        providerId: "google",
        userId: testUser.id,
      });

      // No aging — the session created by `createTestUser` is fresh.
      const res = await app.request("/api/auth/unlink-account", {
        method: "POST",
        headers: { Cookie: testUser.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "google" }),
      });

      expect(res.status).toBe(200);

      const remaining = await db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, testUser.id));
      expect(remaining.map((a) => a.providerId)).toEqual(["credential"]);
    });

    it("refuses to unlink the last remaining account even with a fresh session", async () => {
      const testUser = await createTestUser();

      // The user has ONLY the `credential` account (no social linked). BA's
      // own guard must refuse to delete the last account, independent of the
      // freshness gate (session is fresh here).
      const res = await app.request("/api/auth/unlink-account", {
        method: "POST",
        headers: { Cookie: testUser.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "credential" }),
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);

      // The credential account row still exists — nothing was deleted.
      const remaining = await db
        .select()
        .from(accountTable)
        .where(eq(accountTable.userId, testUser.id));
      expect(remaining.map((a) => a.providerId)).toEqual(["credential"]);
    });
  });
});
