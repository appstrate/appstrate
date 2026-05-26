// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/me/*` — user-scoped identity routes.
 *
 * Covers the auth-method matrix (`cookie session`, API key) for both routes
 * plus the chicken-and-egg invariant: `/api/me/orgs` must succeed WITHOUT
 * `X-Org-Id`. End-user (OIDC) coverage lives in the OIDC module's own
 * integration suite — keeping the OIDC plugin out of this core file
 * preserves the zero-footprint test invariant.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestUser,
  createTestContext,
  createTestOrg,
  authHeaders,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage } from "../../helpers/seed.ts";
import { db } from "../../helpers/db.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

async function seedConnectionFor(opts: {
  orgId: string;
  applicationId: string;
  integrationId: string;
  userId: string;
  label?: string;
}): Promise<string> {
  await seedPackage({
    id: opts.integrationId,
    orgId: opts.orgId,
    type: "integration",
    source: "local",
  });
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationPackageId: opts.integrationId,
      authKey: "google",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      applicationId: opts.applicationId,
      userId: opts.userId,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      label: opts.label ?? null,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

describe("Me API (/api/me)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  describe("GET /api/me/orgs", () => {
    it("returns the orgs the cookie-session caller belongs to", async () => {
      const ctx = await createTestContext({ orgName: "Acme" });

      // Crucially: NO X-Org-Id header — `/api/me/orgs` is the prerequisite
      // to picking one. If `requireOrgContext` was wrongly applied to this
      // route, this request would 400 with `missing_org_context`.
      const res = await app.request("/api/me/orgs", {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string; name: string; slug: string; role: string }>;
      };
      expect(body.data).toBeArray();
      const found = body.data.find((o) => o.id === ctx.orgId);
      expect(found).toBeDefined();
      expect(found?.name).toBe("Acme");
      expect(found?.role).toBe("owner");
    });

    it("returns every org the user is a member of", async () => {
      const user = await createTestUser();
      const { org: orgA } = await createTestOrg(user.id, { slug: "first-org" });
      const { org: orgB } = await createTestOrg(user.id, { slug: "second-org" });

      const res = await app.request("/api/me/orgs", {
        headers: { Cookie: user.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = body.data.map((o) => o.id);
      expect(ids).toContain(orgA.id);
      expect(ids).toContain(orgB.id);
    });

    it("returns an empty list for a fresh user with no memberships", async () => {
      const user = await createTestUser();

      const res = await app.request("/api/me/orgs", {
        headers: { Cookie: user.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
    });

    it("API key sees ONLY its bound org even when the creator belongs to many", async () => {
      const ctx = await createTestContext({ orgSlug: "bound-org" });
      // Creator is also a member of a second org.
      await createTestOrg(ctx.user.id, { slug: "other-org" });

      const apiKey = await seedApiKey({
        createdBy: ctx.user.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        scopes: [],
      });

      const res = await app.request("/api/me/orgs", {
        headers: { Authorization: `Bearer ${apiKey.rawKey}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; slug: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.id).toBe(ctx.orgId);
      expect(body.data[0]?.slug).toBe("bound-org");
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/me/orgs");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/me/models", () => {
    let ctx: TestContext;

    beforeEach(async () => {
      ctx = await createTestContext();
    });

    it("returns the model catalog for the active org (cookie session)", async () => {
      // Org context IS required here — `/api/me/models` runs inside
      // org context (unlike `/api/me/orgs` which precedes it).
      const res = await app.request("/api/me/models", {
        headers: orgOnlyHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toBeArray();
    });

    it("works with API key auth (org pinned by the key)", async () => {
      const apiKey = await seedApiKey({
        createdBy: ctx.user.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        scopes: ["models:read"],
      });

      const res = await app.request("/api/me/models", {
        headers: { Authorization: `Bearer ${apiKey.rawKey}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toBeArray();
    });

    it("rejects API keys without `models:read` scope with 403", async () => {
      const apiKey = await seedApiKey({
        createdBy: ctx.user.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        // Empty scopes — `models:read` is missing.
        scopes: [],
      });

      const res = await app.request("/api/me/models", {
        headers: { Authorization: `Bearer ${apiKey.rawKey}` },
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/me/models");
      expect(res.status).toBe(401);
    });

    it("does NOT return decrypted credentials in the catalog", async () => {
      const res = await app.request("/api/me/models", {
        headers: { ...authHeaders(ctx) },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<Record<string, unknown>>;
      };
      // Catalog DTO must never include `apiKey` — that field is reserved
      // for `models.load()` (single-model resolution from PlatformServices).
      for (const m of body.data) {
        expect(m.apiKey).toBeUndefined();
      }
    });
  });

  describe("GET /api/me/connections", () => {
    type Group = {
      kind: string;
      sourceId: string;
      total_connections: number;
      connections: Array<{ connectionId: string; kind: string; org: { id: string } }>;
    };

    it("returns the caller's integration connections grouped by source", async () => {
      const ctx = await createTestContext({ orgSlug: "conn-org" });
      await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@conn/gmail",
        userId: ctx.user.id,
      });

      // Crosses orgs/apps by design — must succeed WITHOUT X-Org-Id.
      const res = await app.request("/api/me/connections", {
        headers: { Cookie: ctx.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: "list"; data: Group[] };
      expect(body.object).toBe("list");
      const group = body.data.find((g) => g.sourceId === "@conn/gmail");
      expect(group).toBeDefined();
      expect(group?.kind).toBe("integration");
      expect(group?.total_connections).toBe(1);
      expect(group?.connections[0]?.kind).toBe("integration");
    });

    it("aggregates connections across multiple orgs the caller belongs to", async () => {
      const user = await createTestUser();
      const { org: orgA, defaultAppId: appA } = await createTestOrg(user.id, { slug: "org-aa" });
      const { org: orgB, defaultAppId: appB } = await createTestOrg(user.id, { slug: "org-bb" });
      await seedConnectionFor({
        orgId: orgA.id,
        applicationId: appA,
        integrationId: "@conn/a",
        userId: user.id,
      });
      await seedConnectionFor({
        orgId: orgB.id,
        applicationId: appB,
        integrationId: "@conn/b",
        userId: user.id,
      });

      const res = await app.request("/api/me/connections", {
        headers: { Cookie: user.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Group[] };
      const sourceIds = body.data.map((g) => g.sourceId);
      expect(sourceIds).toContain("@conn/a");
      expect(sourceIds).toContain("@conn/b");
    });

    it("does not leak another user's connections", async () => {
      const ctx = await createTestContext({ orgSlug: "owner-org" });
      const other = await createTestUser();
      await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@conn/secret",
        userId: ctx.user.id,
      });

      const res = await app.request("/api/me/connections", {
        headers: { Cookie: other.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Group[] };
      expect(body.data.find((g) => g.sourceId === "@conn/secret")).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/me/connections");
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /api/me/connections/:connectionId", () => {
    it("returns 204 and deletes nothing for a nonexistent connection id (no disclosure)", async () => {
      const ctx = await createTestContext({ orgSlug: "del-org" });
      // Seed one real connection so we can prove the no-op delete left it intact.
      const survivorId = await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@del/gmail",
        userId: ctx.user.id,
      });

      // A random UUID that has no matching row. The route returns 204 (not
      // 404) so a caller probing ids can't distinguish "never existed" from
      // "already deleted" — same end state, no information disclosure.
      const randomId = crypto.randomUUID();
      const res = await app.request(`/api/me/connections/${randomId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(204);

      // The unrelated survivor row is untouched.
      const rows = await db.select({ id: integrationConnections.id }).from(integrationConnections);
      expect(rows.map((r) => r.id)).toContain(survivorId);
      expect(rows).toHaveLength(1);
    });

    it("does not let actor B delete actor A's connection (ownership boundary)", async () => {
      // Actor A owns the connection in their own org/app.
      const ctxA = await createTestContext({ orgSlug: "victim-org" });
      const connId = await seedConnectionFor({
        orgId: ctxA.orgId,
        applicationId: ctxA.defaultAppId,
        integrationId: "@del/owned-by-a",
        userId: ctxA.user.id,
      });

      // Actor B is a completely separate user. /me/* skips org/app context,
      // so B can address the row by id — but the service's (userId | endUserId)
      // ownership filter must refuse to delete a row B doesn't own.
      const userB = await createTestUser();
      const res = await app.request(`/api/me/connections/${connId}`, {
        method: "DELETE",
        headers: { Cookie: userB.cookie },
      });
      // The route still returns 204 (it re-derives scope from the row and the
      // service no-ops on the ownership filter rather than 404-ing), but A's
      // row MUST survive — that's the security boundary under test.
      expect([204, 404]).toContain(res.status);

      const after = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      expect(after).toHaveLength(1);
    });

    it("lets the owner delete their own connection (204, row gone)", async () => {
      const ctx = await createTestContext({ orgSlug: "self-del-org" });
      const connId = await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@del/mine",
        userId: ctx.user.id,
      });

      const res = await app.request(`/api/me/connections/${connId}`, {
        method: "DELETE",
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(204);

      const after = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connId));
      expect(after).toHaveLength(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request(`/api/me/connections/${crypto.randomUUID()}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });
});
