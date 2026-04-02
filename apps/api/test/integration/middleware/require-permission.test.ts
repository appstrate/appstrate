// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the RBAC permission system.
 *
 * Tests that requirePermission() middleware correctly enforces access
 * for all four roles: owner, admin, member, viewer.
 * Uses real HTTP requests through the full middleware chain.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestContext,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const app = getTestApp();

/** Build a context for a user with a specific role in the owner's org. */
async function contextForRole(
  ownerCtx: TestContext,
  role: "admin" | "member" | "viewer",
): Promise<TestContext> {
  const user = await createTestUser();
  await addOrgMember(ownerCtx.orgId, user.id, role);
  return { ...ownerCtx, user, cookie: user.cookie };
}

describe("RBAC — Permission enforcement", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  let viewer: TestContext;

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "rbac-test" });
    admin = await contextForRole(owner, "admin");
    member = await contextForRole(owner, "member");
    viewer = await contextForRole(owner, "viewer");
  });

  // ─── Admin-only routes ─────────────────────────────────────

  describe("models:write (admin-only)", () => {
    it("owner can create model", async () => {
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(owner, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test",
          api: "openai",
          baseUrl: "https://api.example.com",
          modelId: "gpt-4",
          providerKeyId: "pk_test",
        }),
      });
      // May fail due to FK constraint on providerKeyId, but should NOT be 403
      expect(res.status).not.toBe(403);
    });

    it("admin can create model", async () => {
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(admin, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test",
          api: "openai",
          baseUrl: "https://api.example.com",
          modelId: "gpt-4",
          providerKeyId: "pk_test",
        }),
      });
      expect(res.status).not.toBe(403);
    });

    it("member gets 403 on create model", async () => {
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(member, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test",
          api: "openai",
          baseUrl: "https://api.example.com",
          modelId: "gpt-4",
          providerKeyId: "pk_test",
        }),
      });
      expect(res.status).toBe(403);
    });

    it("viewer gets 403 on create model", async () => {
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(viewer, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test",
          api: "openai",
          baseUrl: "https://api.example.com",
          modelId: "gpt-4",
          providerKeyId: "pk_test",
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── API keys (admin-only read) ────────────────────────────

  describe("api-keys:read (admin-only)", () => {
    it("admin can list api keys", async () => {
      const res = await app.request("/api/api-keys", {
        headers: authHeaders(admin),
      });
      expect(res.status).toBe(200);
    });

    it("member gets 403 on list api keys", async () => {
      const res = await app.request("/api/api-keys", {
        headers: authHeaders(member),
      });
      expect(res.status).toBe(403);
    });

    it("viewer gets 403 on list api keys", async () => {
      const res = await app.request("/api/api-keys", {
        headers: authHeaders(viewer),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Webhooks (admin-only) ─────────────────────────────────

  describe("webhooks:read (admin-only)", () => {
    it("admin can list webhooks", async () => {
      const res = await app.request("/api/webhooks", {
        headers: authHeaders(admin),
      });
      expect(res.status).toBe(200);
    });

    it("member gets 403 on list webhooks", async () => {
      const res = await app.request("/api/webhooks", {
        headers: authHeaders(member),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Provider keys (admin-only read) ───────────────────────

  describe("provider-keys:read (admin-only)", () => {
    it("admin can list provider keys", async () => {
      const res = await app.request("/api/provider-keys", {
        headers: authHeaders(admin),
      });
      expect(res.status).toBe(200);
    });

    it("member gets 403 on list provider keys", async () => {
      const res = await app.request("/api/provider-keys", {
        headers: authHeaders(member),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Member-accessible routes ──────────────────────────────

  describe("schedules:write (member-accessible)", () => {
    it("member can access schedule creation endpoint", async () => {
      await seedPackage({
        id: `@rbac-test/test-agent`,
        orgId: owner.orgId,
      });
      const res = await app.request(`/api/agents/@rbac-test/test-agent/schedules`, {
        method: "POST",
        headers: authHeaders(member, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          connectionProfileId: "00000000-0000-0000-0000-000000000000",
          cronExpression: "0 9 * * 1",
        }),
      });
      // Should not be a PERMISSION 403 — may fail for other reasons (invalid profile → 403 "forbidden")
      if (res.status === 403) {
        const body = (await res.json()) as Record<string, unknown>;
        // If 403, it should NOT be a permission error — just ownership
        expect(body.detail as string).not.toContain("schedules:write");
      }
    });

    it("viewer gets 403 on schedule creation", async () => {
      await seedPackage({ id: `@rbac-test/test-agent`, orgId: owner.orgId });
      const res = await app.request(`/api/agents/@rbac-test/test-agent/schedules`, {
        method: "POST",
        headers: authHeaders(viewer, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          connectionProfileId: "00000000-0000-0000-0000-000000000000",
          cronExpression: "0 9 * * 1",
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── Organization management (uses inline requireOrgRole, not middleware) ──

  describe("org routes (inline auth)", () => {
    it("admin gets 403 on delete org (owner-only)", async () => {
      const res = await app.request(`/api/orgs/${owner.orgId}`, {
        method: "DELETE",
        headers: { Cookie: admin.cookie },
      });
      expect(res.status).toBe(403);
    });

    it("admin can invite members", async () => {
      const res = await app.request(`/api/orgs/${owner.orgId}/members`, {
        method: "POST",
        headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invite@test.com", role: "member" }),
      });
      expect(res.status).not.toBe(403);
    });

    it("member gets 403 on invite", async () => {
      const res = await app.request(`/api/orgs/${owner.orgId}/members`, {
        method: "POST",
        headers: { Cookie: member.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invite@test.com", role: "member" }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ─── 403 response format ───────────────────────────────────

  describe("403 response format", () => {
    it("returns RFC 9457 problem detail", async () => {
      const res = await app.request("/api/models", {
        method: "POST",
        headers: authHeaders(member, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          label: "Test",
          api: "openai",
          baseUrl: "https://api.example.com",
          modelId: "gpt-4",
          providerKeyId: "pk_test",
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("forbidden");
      expect(body.status).toBe(403);
      expect(typeof body.detail).toBe("string");
      expect(body.detail as string).toContain("models:write");
    });
  });

  // ─── Read routes accessible to all ─────────────────────────

  describe("read routes accessible to all roles", () => {
    it("viewer can list agents", async () => {
      const res = await app.request("/api/agents", {
        headers: authHeaders(viewer),
      });
      expect(res.status).toBe(200);
    });

    it("viewer can list models", async () => {
      const res = await app.request("/api/models", {
        headers: authHeaders(viewer),
      });
      expect(res.status).toBe(200);
    });

    it("viewer can list applications", async () => {
      const res = await app.request("/api/applications", {
        headers: authHeaders(viewer),
      });
      expect(res.status).toBe(200);
    });
  });
});
