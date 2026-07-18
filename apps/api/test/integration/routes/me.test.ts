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
import {
  seedApiKey,
  seedPackage,
  seedApplication,
  seedInstalledPackage,
} from "../../helpers/seed.ts";
import { db } from "../../helpers/db.ts";
import { assertDbHas } from "../../helpers/assertions.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

async function seedConnectionFor(opts: {
  orgId: string;
  applicationId: string;
  integrationId: string;
  userId: string;
  label?: string;
  sharedWithOrg?: boolean;
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
      integrationId: opts.integrationId,
      authKey: "google",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      applicationId: opts.applicationId,
      userId: opts.userId,
      credentialsEncrypted: "x",
      scopesGranted: ["openid", "email"],
      label: opts.label ?? null,
      sharedWithOrg: opts.sharedWithOrg ?? false,
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

  describe("GET /api/me/context", () => {
    let ctx: TestContext;
    beforeEach(async () => {
      ctx = await createTestContext();
    });

    it("returns identity, org role, and usable integrations (own + org-shared), app-scoped", async () => {
      // Own connection in the current app → source "own".
      await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@ctx/gmail",
        userId: ctx.user.id,
      });

      // Connection owned by ANOTHER user but shared with the org, same app → "shared".
      const other = await createTestUser();
      await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        integrationId: "@ctx/clickup",
        userId: other.id,
        sharedWithOrg: true,
      });

      // Connection in a DIFFERENT app of the same org → must NOT appear.
      const otherApp = await seedApplication({ orgId: ctx.orgId });
      await seedConnectionFor({
        orgId: ctx.orgId,
        applicationId: otherApp.id,
        integrationId: "@ctx/other-app",
        userId: ctx.user.id,
      });

      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: { id: string; name: string | null; email: string | null };
        org: { id: string; role: string };
        connections: { integration_id: string; name: string; source: string }[];
      };

      expect(body.user.id).toBe(ctx.user.id);
      expect(body.org.id).toBe(ctx.orgId);
      expect(body.org.role).toBe("owner");

      const byId = new Map(body.connections.map((c) => [c.integration_id, c]));
      expect(byId.get("@ctx/gmail")?.source).toBe("own");
      expect(byId.get("@ctx/clickup")?.source).toBe("shared");
      expect(byId.has("@ctx/other-app")).toBe(false);
    });

    it("lists runnable agents (enabled only) with invokable id and input flag", async () => {
      // Enabled installed agent → appears, takes_input from its input schema.
      await seedPackage({
        id: "@ctx/triage",
        orgId: ctx.orgId,
        draftManifest: {
          name: "@ctx/triage",
          version: "0.1.0",
          type: "agent",
          display_name: "Triage",
          description: "Sorts email.",
          input: { schema: { type: "object", properties: { folder: { type: "string" } } } },
        },
      });
      await seedInstalledPackage(ctx.defaultAppId, "@ctx/triage");

      // Installed but disabled in the app → must NOT appear.
      await seedPackage({ id: "@ctx/disabled", orgId: ctx.orgId });
      await seedInstalledPackage(ctx.defaultAppId, "@ctx/disabled", { enabled: false });

      // Owned by the org but NOT installed in this app → must NOT appear.
      await seedPackage({ id: "@ctx/uninstalled", orgId: ctx.orgId });

      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agents: {
          package_id: string;
          display_name: string;
          takes_input: boolean;
          published: boolean;
        }[];
        agents_truncated: boolean;
        agents_total: number;
      };

      const ids = new Set(body.agents.map((a) => a.package_id));
      expect(ids.has("@ctx/triage")).toBe(true);
      expect(ids.has("@ctx/disabled")).toBe(false);
      expect(ids.has("@ctx/uninstalled")).toBe(false);
      const triage = body.agents.find((a) => a.package_id === "@ctx/triage");
      expect(triage?.display_name).toBe("Triage");
      expect(triage?.takes_input).toBe(true);
      // No `latest` dist-tag was seeded → draft-only agent → must run with version=draft.
      expect(triage?.published).toBe(false);
      expect(body.agents_truncated).toBe(false);
    });

    it("lists installed skills (enabled only) with attachable id and version", async () => {
      // Enabled installed skill → appears with its manifest version.
      await seedPackage({
        id: "@ctx/web-research",
        orgId: ctx.orgId,
        type: "skill",
        draftManifest: {
          name: "@ctx/web-research",
          version: "1.2.0",
          type: "skill",
          display_name: "Web Research",
          description: "Searches the web.",
        },
      });
      await seedInstalledPackage(ctx.defaultAppId, "@ctx/web-research");

      // Installed but disabled in the app → must NOT appear.
      await seedPackage({ id: "@ctx/skill-disabled", orgId: ctx.orgId, type: "skill" });
      await seedInstalledPackage(ctx.defaultAppId, "@ctx/skill-disabled", { enabled: false });

      // Owned by the org but NOT installed in this app → must NOT appear.
      await seedPackage({ id: "@ctx/skill-uninstalled", orgId: ctx.orgId, type: "skill" });

      const res = await app.request("/api/me/context", { headers: authHeaders(ctx) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        skills: { package_id: string; display_name: string; version: string | null }[];
        skills_truncated: boolean;
        skills_total: number;
      };

      const ids = new Set(body.skills.map((s) => s.package_id));
      expect(ids.has("@ctx/web-research")).toBe(true);
      expect(ids.has("@ctx/skill-disabled")).toBe(false);
      expect(ids.has("@ctx/skill-uninstalled")).toBe(false);
      const skill = body.skills.find((s) => s.package_id === "@ctx/web-research");
      expect(skill?.display_name).toBe("Web Research");
      expect(skill?.version).toBe("1.2.0");
      expect(body.skills_truncated).toBe(false);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/me/context");
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
      source_id: string;
      total_connections: number;
      connections: Array<{ connection_id: string; kind: string; org: { id: string } }>;
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
      const group = body.data.find((g) => g.source_id === "@conn/gmail");
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
      const sourceIds = body.data.map((g) => g.source_id);
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
      expect(body.data.find((g) => g.source_id === "@conn/secret")).toBeUndefined();
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

  // ── CRIT-03 — /me/connections is (org, application)-scoped for an API key ──
  //
  // An API key authenticates as its CREATOR, but the key itself is bound to
  // one org + one application. `listMeConnections(actor, authority)` now takes
  // a required authority: `api_key` → `app_scoped` with the key's own
  // orgId/applicationId. Pre-fix, the key inherited the creator's cross-org
  // `user_global` view — a leaked key could enumerate (and destructively
  // delete) the creator's connections in EVERY org they belong to.
  describe("/api/me/connections API-key authority scoping (CRIT-03)", () => {
    type Group = {
      source_id: string;
      connections: Array<{ connection_id: string; org: { id: string } }>;
    };

    async function setupTwoOrgConnections() {
      const user = await createTestUser();
      const { org: orgA, defaultAppId: appA } = await createTestOrg(user.id, {
        slug: "crit03-org-a",
      });
      const { org: orgB, defaultAppId: appB } = await createTestOrg(user.id, {
        slug: "crit03-org-b",
      });
      const connA = await seedConnectionFor({
        orgId: orgA.id,
        applicationId: appA,
        integrationId: "@crit03/conn-a",
        userId: user.id,
      });
      const connB = await seedConnectionFor({
        orgId: orgB.id,
        applicationId: appB,
        integrationId: "@crit03/conn-b",
        userId: user.id,
      });
      // Key bound to org A's default application, created by the same user.
      const apiKey = await seedApiKey({
        orgId: orgA.id,
        applicationId: appA,
        createdBy: user.id,
        scopes: [],
      });
      return { user, orgA, orgB, connA, connB, bearer: `Bearer ${apiKey.rawKey}` };
    }

    it("cookie session lists connections from BOTH orgs (cross-org dashboard intact)", async () => {
      const { user, connA, connB } = await setupTwoOrgConnections();

      const res = await app.request("/api/me/connections", {
        headers: { Cookie: user.cookie },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Group[] };
      const connectionIds = body.data.flatMap((g) => g.connections.map((c) => c.connection_id));
      expect(connectionIds).toContain(connA);
      expect(connectionIds).toContain(connB);
    });

    it("an API key bound to org A lists ONLY the org-A connection", async () => {
      const { orgA, connA, connB, bearer } = await setupTwoOrgConnections();

      const res = await app.request("/api/me/connections", {
        headers: { Authorization: bearer },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Group[] };
      const connectionIds = body.data.flatMap((g) => g.connections.map((c) => c.connection_id));
      expect(connectionIds).toContain(connA);
      // Pre-fix, the creator's cross-org view leaked the org-B connection here.
      expect(connectionIds).not.toContain(connB);
      for (const group of body.data) {
        for (const conn of group.connections) {
          expect(conn.org.id).toBe(orgA.id);
        }
      }
    });

    it("an org-A API key cannot delete the org-B connection (row survives)", async () => {
      const { connB, bearer } = await setupTwoOrgConnections();

      const res = await app.request(`/api/me/connections/${connB}`, {
        method: "DELETE",
        headers: { Authorization: bearer },
      });

      // 204 by design — non-disclosure: a probing key must not learn whether
      // the id exists outside its boundary. The security assertion is the DB
      // state, not the status code.
      expect(res.status).toBe(204);
      await assertDbHas(integrationConnections, eq(integrationConnections.id, connB));
    });

    it("an org-A API key CAN delete a connection inside its own (org, application)", async () => {
      const { connA, bearer } = await setupTwoOrgConnections();

      const res = await app.request(`/api/me/connections/${connA}`, {
        method: "DELETE",
        headers: { Authorization: bearer },
      });

      expect(res.status).toBe(204);
      const after = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connA));
      expect(after).toHaveLength(0);
    });
  });
});
