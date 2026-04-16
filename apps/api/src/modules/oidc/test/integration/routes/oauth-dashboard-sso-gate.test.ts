// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the per-org `dashboardSsoEnabled` gate on org-level OAuth clients.
 *
 * Org-level (level="org") OAuth clients only work when the owning org has
 * opted in. This file exercises every gated surface:
 *   - Admin writes: POST / PATCH / rotate (blocked when off, allowed when on)
 *   - Admin reads: GET list / GET detail (always allowed)
 *   - Admin delete: always allowed (cleanup path)
 *   - Interactive flow: /api/oauth/login renders an error page when off
 *   - Application-level clients are unaffected at every surface
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { organizations } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  enableDashboardSso,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

function orgBody(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    level: "org" as const,
    name: "Internal Admin",
    redirectUris: ["https://admin.example.com/cb"],
    referencedOrgId: ctx.orgId,
    ...overrides,
  };
}

function appBody(ctx: TestContext, overrides: Record<string, unknown> = {}) {
  return {
    level: "application" as const,
    name: "Customer App",
    redirectUris: ["https://app.example.com/cb"],
    referencedApplicationId: ctx.defaultAppId,
    ...overrides,
  };
}

async function postClient(ctx: TestContext, body: unknown): Promise<Response> {
  return app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Dashboard SSO gate (dashboardSsoEnabled)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "ssogate" });
  });

  describe("POST /api/oauth/clients (create)", () => {
    it("rejects org-level creation with 403 when flag is absent (default off)", async () => {
      const res = await postClient(ctx, orgBody(ctx));
      expect(res.status).toBe(403);
    });

    it("rejects org-level creation with 403 when flag is explicitly false", async () => {
      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));
      const res = await postClient(ctx, orgBody(ctx));
      expect(res.status).toBe(403);
    });

    it("allows org-level creation with 201 after flag is enabled", async () => {
      await enableDashboardSso(ctx.orgId);
      const res = await postClient(ctx, orgBody(ctx));
      expect(res.status).toBe(201);
    });

    it("app-level creation is always allowed regardless of flag", async () => {
      const res = await postClient(ctx, appBody(ctx));
      expect(res.status).toBe(201);
    });

    it("flipping the flag on-then-off blocks future creation", async () => {
      await enableDashboardSso(ctx.orgId);
      const ok = await postClient(ctx, orgBody(ctx));
      expect(ok.status).toBe(201);

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const blocked = await postClient(
        ctx,
        orgBody(ctx, { name: "Second", redirectUris: ["https://admin2.example.com/cb"] }),
      );
      expect(blocked.status).toBe(403);
    });
  });

  describe("PATCH /api/oauth/clients/:clientId", () => {
    it("blocks PATCH on org-level client when flag is off", async () => {
      await enableDashboardSso(ctx.orgId);
      const created = await postClient(ctx, orgBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(`/api/oauth/clients/${clientId}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(403);
    });

    it("allows PATCH on app-level client regardless of flag", async () => {
      const created = await postClient(ctx, appBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      const res = await app.request(`/api/oauth/clients/${clientId}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/oauth/clients/:clientId/rotate", () => {
    it("blocks rotate on org-level client when flag is off", async () => {
      await enableDashboardSso(ctx.orgId);
      const created = await postClient(ctx, orgBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(`/api/oauth/clients/${clientId}/rotate`, {
        method: "POST",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/oauth/clients/:clientId", () => {
    it("allows DELETE on org-level client even when flag is off (cleanup path)", async () => {
      await enableDashboardSso(ctx.orgId);
      const created = await postClient(ctx, orgBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(`/api/oauth/clients/${clientId}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(204);
    });
  });

  describe("GET /api/oauth/clients (list)", () => {
    it("keeps listing org-level clients even when flag is off (audit path)", async () => {
      await enableDashboardSso(ctx.orgId);
      const created = await postClient(ctx, orgBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request("/api/oauth/clients", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { clientId: string }[] };
      expect(body.data.some((c) => c.clientId === clientId)).toBe(true);
    });
  });

  describe("GET /api/oauth/login (interactive flow)", () => {
    it("renders an SSO-disabled error when the org-level client's org has flag off", async () => {
      await enableDashboardSso(ctx.orgId);
      const created = await postClient(ctx, orgBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      await db
        .update(organizations)
        .set({ orgSettings: { dashboardSsoEnabled: false } })
        .where(eq(organizations.id, ctx.orgId));

      const res = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain("SSO désactivé");
    });

    it("renders normally for an app-level client regardless of org flag", async () => {
      const created = await postClient(ctx, appBody(ctx));
      const { clientId } = (await created.json()) as { clientId: string };

      const res = await app.request(
        `/api/oauth/login?client_id=${encodeURIComponent(clientId)}&state=x`,
      );
      expect(res.status).toBe(200);
    });
  });
});
