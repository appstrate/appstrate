// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedApplication } from "../../helpers/seed.ts";
import { apiKeys } from "@appstrate/db/schema";

const app = getTestApp();

describe("API Keys API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  describe("GET /api/api-keys", () => {
    it("returns empty list when no keys exist", async () => {
      const res = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.apiKeys).toBeArray();
      expect(body.apiKeys).toHaveLength(0);
    });

    it("returns keys after creation", async () => {
      // Create a key first
      await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      const res = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.apiKeys).toHaveLength(1);
      expect(body.apiKeys[0].name).toBe("Test Key");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/api-keys");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/api-keys", () => {
    it("creates an API key with name and applicationId", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "My API Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.id).toBeDefined();
      expect(body.key).toBeDefined();
      expect(body.keyPrefix).toBeDefined();
    });

    it("created key has ask_ prefix", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Prefixed Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.key).toStartWith("ask_");
      expect(body.keyPrefix).toStartWith("ask_");
    });
  });

  describe("DELETE /api/api-keys/:id", () => {
    it("deletes an API key and returns 204", async () => {
      // Create a key
      const createRes = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "To Delete",
          applicationId: ctx.defaultAppId,
        }),
      });
      const { id } = (await createRes.json()) as any;

      // Delete it
      const deleteRes = await app.request(`/api/api-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(deleteRes.status).toBe(204);
    });

    it("deleted key no longer appears in list", async () => {
      // Create a key
      const createRes = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Ephemeral Key",
          applicationId: ctx.defaultAppId,
        }),
      });
      const { id } = (await createRes.json()) as any;

      // Delete it
      await app.request(`/api/api-keys/${id}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      // Verify it is gone
      const listRes = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });
      const body = (await listRes.json()) as any;
      const found = body.apiKeys.find((k: { id: string }) => k.id === id);
      expect(found).toBeUndefined();
    });
  });

  describe("POST /api/api-keys — scopes", () => {
    it("creates key with valid scopes", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Scoped Key",
          applicationId: ctx.defaultAppId,
          scopes: ["agents:read", "agents:run", "runs:read"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes).toContain("agents:read");
      expect(body.scopes).toContain("agents:run");
      expect(body.scopes).toContain("runs:read");
    });

    it("creates key without scopes (defaults to all API-key-allowed scopes)", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Full Access Key",
          applicationId: ctx.defaultAppId,
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes.length).toBeGreaterThan(20);
      expect(body.scopes).toContain("agents:read");
      expect(body.scopes).toContain("agents:run");
    });

    it("filters out session-only scopes (org:*, billing:*)", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Session Scope Key",
          applicationId: ctx.defaultAppId,
          scopes: ["agents:read", "org:delete", "billing:manage", "members:invite"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toEqual(["agents:read"]);
    });

    it("filters out invalid scope strings", async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Invalid Scope Key",
          applicationId: ctx.defaultAppId,
          scopes: ["agents:read", "not-a-scope", "invalid:permission"],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.scopes).toEqual(["agents:read"]);
    });

    it("scoped key appears in list with scopes", async () => {
      await app.request("/api/api-keys", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Listed Scoped Key",
          applicationId: ctx.defaultAppId,
          scopes: ["agents:read", "agents:run"],
        }),
      });

      const listRes = await app.request("/api/api-keys", {
        headers: authHeaders(ctx),
      });
      const body = (await listRes.json()) as any;
      expect(body.apiKeys[0].scopes).toContain("agents:read");
      expect(body.apiKeys[0].scopes).toContain("agents:run");
    });
  });

  describe("GET /api/api-keys/available-scopes", () => {
    it("returns scopes for owner", async () => {
      const res = await app.request("/api/api-keys/available-scopes", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.scopes).toBeArray();
      expect(body.scopes.length).toBeGreaterThan(20);
      expect(body.scopes).toContain("agents:read");
      expect(body.scopes).toContain("agents:write");
      expect(body.scopes).toContain("runs:read");
      // Session-only scopes should NOT be present
      expect(body.scopes).not.toContain("org:delete");
      expect(body.scopes).not.toContain("billing:manage");
    });

    it("returns 403 for member (api-keys:read is admin-only)", async () => {
      const member = await createTestUser();
      await addOrgMember(ctx.orgId, member.id, "member");
      const memberCtx: TestContext = { ...ctx, user: member, cookie: member.cookie };

      const res = await app.request("/api/api-keys/available-scopes", {
        headers: authHeaders(memberCtx),
      });
      expect(res.status).toBe(403);
    });
  });

  // Issue #172 (extension) — `revokeApiKey(keyId, orgId)` filtered by org
  // only, letting an API key in App A revoke any key in the org (other
  // apps included). The fix passes the caller's bound applicationId for
  // API-key auth; sessions stay org-wide.
  describe("API key cross-app revoke (issue #172 extension)", () => {
    it("API key in App A cannot revoke a key in App B (same org)", async () => {
      const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other App" });
      const callerKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        scopes: ["api-keys:revoke"],
      });
      const victimKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: otherApp.id,
        createdBy: ctx.user.id,
        name: "Victim Key",
      });

      const res = await app.request(`/api/api-keys/${victimKey.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${callerKey.rawKey}` },
      });
      expect(res.status).toBe(404);

      const [row] = await db
        .select({ revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, victimKey.id));
      expect(row?.revokedAt).toBeNull();
    });

    it("API key can still revoke another key in its own application", async () => {
      const callerKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        scopes: ["api-keys:revoke"],
      });
      const peerKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        createdBy: ctx.user.id,
        name: "Peer Key",
      });

      const res = await app.request(`/api/api-keys/${peerKey.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${callerKey.rawKey}` },
      });
      expect(res.status).toBe(204);
    });

    it("session admin can revoke any key in the org (regression guard)", async () => {
      const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other App 2" });
      const victimKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: otherApp.id,
        createdBy: ctx.user.id,
        name: "Victim Key Session",
      });

      const res = await app.request(`/api/api-keys/${victimKey.id}`, {
        method: "DELETE",
        headers: { ...authHeaders(ctx) },
      });
      expect(res.status).toBe(204);
    });
  });
});
