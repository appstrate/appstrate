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
import { seedApiKey } from "../../helpers/seed.ts";

const app = getTestApp();

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
        organizations: Array<{ id: string; name: string; slug: string; role: string }>;
      };
      expect(body.organizations).toBeArray();
      const found = body.organizations.find((o) => o.id === ctx.orgId);
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
      const body = (await res.json()) as { organizations: Array<{ id: string }> };
      const ids = body.organizations.map((o) => o.id);
      expect(ids).toContain(orgA.id);
      expect(ids).toContain(orgB.id);
    });

    it("returns an empty list for a fresh user with no memberships", async () => {
      const user = await createTestUser();

      const res = await app.request("/api/me/orgs", {
        headers: { Cookie: user.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { organizations: unknown[] };
      expect(body.organizations).toEqual([]);
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
      const body = (await res.json()) as { organizations: Array<{ id: string; slug: string }> };
      expect(body.organizations).toHaveLength(1);
      expect(body.organizations[0]?.id).toBe(ctx.orgId);
      expect(body.organizations[0]?.slug).toBe("bound-org");
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
});
