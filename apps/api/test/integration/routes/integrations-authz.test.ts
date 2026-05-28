// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP route/middleware authorization tests for `/api/integrations/*` that
 * the existing `integrations.test.ts` (happy-path + CRUD) and the
 * service-level suites do NOT exercise:
 *
 *   1. block_user_connections workflow — admin PATCH /settings flips the gate;
 *      a non-admin MEMBER hitting connect/fields gets 403 with detail
 *      `connection_blocked_by_admin`; an ADMIN is exempt.
 *   2. PATCH /:packageId/connections/:connectionId metadata authorization —
 *      owner edit (200), admin toggling sharedWithOrg on a row they don't own
 *      (403, owner-consent rule), unrelated member (403), foreign-app row (404).
 *   3. assertOrgAdmin defense-in-depth on admin writes — documents the
 *      reachable behavior of the role/scope intersection model.
 *   4. connect/oauth2 reconnect scope-union (incremental consent) — the
 *      returned authorize URL never shrinks below the connection's
 *      previously-granted scopes.
 *
 * These target the route handlers' guards directly via the real Hono app +
 * real DB, complementing the connection/pin/scope service unit coverage.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedApiKey, seedApplication } from "../../helpers/seed.ts";
import { eq } from "drizzle-orm";
import { integrationConnections, applicationPackages } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";

const app = getTestApp();

function gmailManifest(name = "@myorg/gmail"): IntegrationManifest {
  return localIntegrationManifest({
    name,
    version: "0.1.0",
    displayName: "Gmail",
    description: "Gmail integration",
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        delivery: httpHeaderDelivery({ name: "Authorization", prefix: "Bearer", field: "api_key" }),
      },
      google: {
        type: "oauth2",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        defaultScopes: ["openid", "email"],
        authorizedUris: ["https://www.googleapis.com/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer",
          field: "access_token",
        }),
      },
    },
  });
}

async function seedIntegration(orgId: string, manifest: IntegrationManifest) {
  return seedPackage({
    id: manifest.name,
    orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
}

/** Activate (install) the integration in the application. */
async function activate(applicationId: string, packageId: string): Promise<void> {
  await db.insert(applicationPackages).values({ applicationId, packageId, config: {} });
}

function memberHeaders(
  cookie: string,
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: cookie,
    "X-Org-Id": ctx.orgId,
    "X-Application-Id": ctx.defaultAppId,
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. block_user_connections workflow
// ─────────────────────────────────────────────────────────────────────────

describe("block_user_connections workflow", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await activate(ctx.defaultAppId, "@myorg/gmail");
  });

  it("admin can set blockUserConnections=true via PATCH /settings", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocked: boolean };
    expect(body.blocked).toBe(true);

    // Persisted on the application_packages row.
    const [row] = await db
      .select({ blocked: applicationPackages.blockUserConnections })
      .from(applicationPackages)
      .where(eq(applicationPackages.packageId, "@myorg/gmail"));
    expect(row?.blocked).toBe(true);
  });

  it("403s a non-admin MEMBER's connect/fields with detail `connection_blocked_by_admin` when the gate is on", async () => {
    // Admin flips the gate on.
    await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });

    // A plain member holds `integrations:connect` (so it clears
    // requirePermission) but `assertConnectionCreationAllowed` refuses it
    // because the (app, integration) gate is on and the member is not admin.
    const member = await createTestUser({ email: "blocked-member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");

    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: memberHeaders(member.cookie, ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("connection_blocked_by_admin");
    expect(body.detail ?? "").toMatch(/disabled by the organization admin/i);

    // Nothing persisted — the gate fires before strategy.complete.
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    expect(rows).toHaveLength(0);
  });

  it("exempts an ADMIN from the gate (passes through to create the connection)", async () => {
    // Gate on.
    await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });

    // ctx.user is the org owner (admin-equivalent) — `assertConnectionCreationAllowed`
    // returns early for owner/admin, so the connect succeeds even with the
    // gate on (this is how the admin creates the shared connection).
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { id: string; auth_key: string };
    expect(conn.auth_key).toBe("api");

    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    expect(rows).toHaveLength(1);
  });

  it("does NOT block a member when the gate is off (default)", async () => {
    // No PATCH — gate defaults to false. A member can self-connect.
    const member = await createTestUser({ email: "free-member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");

    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: memberHeaders(member.cookie, ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. PATCH /:packageId/connections/:connectionId — metadata authorization
// ─────────────────────────────────────────────────────────────────────────

describe("PATCH /api/integrations/:packageId/connections/:connectionId", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await activate(ctx.defaultAppId, "@myorg/gmail");
  });

  /** Insert a connection owned by `userId` in ctx's default app. */
  async function seedConn(opts: {
    userId: string;
    shared?: boolean;
    applicationId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        applicationId: opts.applicationId ?? ctx.defaultAppId,
        userId: opts.userId,
        credentialsEncrypted: "x",
        scopesGranted: ["openid", "email"],
        sharedWithOrg: opts.shared ?? false,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("lets the owner edit the label (200)", async () => {
    const connId = await seedConn({ userId: ctx.user.id });
    const res = await app.request(`/api/integrations/@myorg/gmail/connections/${connId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "My Gmail" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string };
    expect(body.label).toBe("My Gmail");

    const [row] = await db
      .select({ label: integrationConnections.label })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row?.label).toBe("My Gmail");
  });

  it("403s an admin toggling sharedWithOrg on a connection they don't own (owner-consent rule)", async () => {
    // Connection owned by a member, NOT by the admin (ctx.user is owner/admin).
    const member = await createTestUser({ email: "conn-owner@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const connId = await seedConn({ userId: member.id });

    const res = await app.request(`/api/integrations/@myorg/gmail/connections/${connId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ shared_with_org: true }),
    });
    // Admin is allowed to edit metadata in general, but shared_with_org is
    // consent — only the owner may flip it.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/only the connection owner can change shared_with_org/i);

    // Not flipped.
    const [row] = await db
      .select({ shared: integrationConnections.sharedWithOrg })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connId));
    expect(row?.shared).toBe(false);
  });

  it("403s an unrelated member editing someone else's connection", async () => {
    // Connection owned by ctx.user (owner). An unrelated member is neither
    // owner nor admin → refused before any field-specific check.
    const connId = await seedConn({ userId: ctx.user.id });
    const member = await createTestUser({ email: "stranger@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");

    const res = await app.request(`/api/integrations/@myorg/gmail/connections/${connId}`, {
      method: "PATCH",
      headers: memberHeaders(member.cookie, ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ label: "hijack" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail ?? "").toMatch(/connection owner or an org admin/i);
  });

  it("404s a connection that belongs to a different application", async () => {
    // A second application in the SAME org; the connection lives there, so the
    // route's `ownership.applicationId !== scope.applicationId` check 404s
    // (scope is ctx.defaultAppId via the headers).
    const otherApp = await seedApplication({ orgId: ctx.orgId, name: "Other App" });
    const connId = await seedConn({ userId: ctx.user.id, applicationId: otherApp.id });

    const res = await app.request(`/api/integrations/@myorg/gmail/connections/${connId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. assertOrgAdmin defense-in-depth on pin/default writes
// ─────────────────────────────────────────────────────────────────────────

describe("assertOrgAdmin defense-in-depth (api-key role/scope intersection)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await activate(ctx.defaultAppId, "@myorg/gmail");
  });

  async function seedSharedConn(): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["openid", "email"],
        sharedWithOrg: true,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("admin-created api key WITH integrations:install passes both requirePermission and assertOrgAdmin", async () => {
    // The only way an api key can hold `integrations:install` is to be minted
    // by an admin/owner (resolveApiKeyPermissions intersects the requested
    // scopes with the creator's role grants). Such a key's `orgRole` is the
    // creator's admin role, so assertOrgAdmin lets it through. This pins the
    // positive path the defense-in-depth guard deliberately allows.
    const connId = await seedSharedConn();
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: ctx.user.id, // owner
      scopes: ["integrations:install"],
    });

    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection_id: string };
    expect(body.connection_id).toBe(connId);
  });

  it("member-created api key requesting integrations:install is stripped to 403 at requirePermission", async () => {
    // Mint the key on a MEMBER creator while requesting `integrations:install`.
    // resolveApiKeyPermissions intersects with member grants (which lack
    // install), so the effective permission set never contains it — the
    // request 403s at requirePermission, never reaching assertOrgAdmin. This
    // is why the assertOrgAdmin guard is genuinely defense-in-depth: there is
    // no reachable state where the install scope is held by a non-admin.
    const connId = await seedSharedConn();
    const member = await createTestUser({ email: "member-key@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const key = await seedApiKey({
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      createdBy: member.id,
      scopes: ["integrations:install"],
    });

    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. connect/oauth2 reconnect scope-union (incremental consent)
// ─────────────────────────────────────────────────────────────────────────

describe("connect/oauth2 reconnect scope-union (incremental consent)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await activate(ctx.defaultAppId, "@myorg/gmail");
    // Register the OAuth client so the kickoff can build an authorize URL.
    await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
    });
  });

  it("unions the target connection's previously-granted scopes into the authorize URL (never shrinks)", async () => {
    // Seed a connection that already authorized a scope NOT in the manifest
    // defaults (["openid","email"]). A reconnect must re-request it so
    // re-consent never silently drops what the account already granted.
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
        sharedWithOrg: false,
      })
      .returning({ id: integrationConnections.id });
    const connId = row!.id;

    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string };
    const scope = new URL(body.auth_url).searchParams.get("scope") ?? "";
    const scopes = scope.split(/\s+/);
    // Manifest defaults preserved...
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    // ...AND the previously-granted scope is re-requested (the incremental-
    // consent union). A bug that ignored connectionId would drop this.
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("a fresh connect (no connectionId) requests only the manifest defaults", async () => {
    // Sanity foil: without connectionId there is no granted set to union, so
    // the kickoff stays at defaults — proving the readonly scope above came
    // from the connection row, not from leaking state.
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string };
    const scope = new URL(body.auth_url).searchParams.get("scope") ?? "";
    const scopes = scope.split(/\s+/);
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/gmail.readonly");
  });
});
