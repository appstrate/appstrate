// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP route/middleware authorization tests for `/api/integrations/*` that
 * the existing `integrations.test.ts` (happy-path + CRUD) and the
 * service-level suites do NOT exercise:
 *
 *   1. block_user_connections workflow — an `integrations:configure` holder
 *      PATCHes /settings to flip the gate; a plain MEMBER hitting
 *      connect/fields gets 403 with detail `connection_blocked_by_admin`; an
 *      owner SESSION is exempt, an owner-minted API KEY is not.
 *   2. PATCH /:packageId/connections/:connectionId metadata authorization —
 *      owner edit (200), admin toggling sharedWithOrg on a row they don't own
 *      (403, owner-consent rule), unrelated member (403), foreign-space row (404).
 *   3. `integrations:configure` is session-only — the governance mutations
 *      (settings gate, agent pins, org default) refuse every API key,
 *      whatever its creator's role.
 *   4. connect/oauth2 reconnect scope-union (incremental consent) — the
 *      returned authorize URL never shrinks below the connection's
 *      previously-granted scopes.
 *
 * These target the route handlers' guards directly via the real Hono app +
 * real DB, complementing the connection/pin/scope service unit coverage.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  createTestUser,
  addOrgMember,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedApiKey, seedSpace } from "../../helpers/seed.ts";
import { validateScopes } from "../../../src/lib/permissions.ts";
import { eq } from "drizzle-orm";
import { integrationConnections, spacePackages } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  localIntegrationManifest,
  httpHeaderDelivery,
} from "../../helpers/integration-manifests.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";

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
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
          field: "api_key",
        }),
      },
      google: {
        type: "oauth2",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        defaultScopes: ["openid", "email"],
        authorizedUris: ["https://www.googleapis.com/**"],
        delivery: httpHeaderDelivery({
          name: "Authorization",
          prefix: "Bearer ",
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

/** Activate (install) the integration in the space. */
async function activate(spaceId: string, packageId: string): Promise<void> {
  await db.insert(spacePackages).values({ spaceId, packageId });
}

function memberHeaders(
  cookie: string,
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: cookie,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
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
    await activate(ctx.defaultSpaceId, "@myorg/gmail");
  });

  it("admin can set blockUserConnections=true via PATCH /settings", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });
    expect(res.status).toBe(200);
    // 200 + the bare integration detail resource (#657): the toggled gate is
    // the resource's `block_user_connections` field, not a `{blocked}` scrap.
    const body = (await res.json()) as {
      block_user_connections: boolean;
      active: boolean;
      manifest: { name: string };
      auths: unknown[];
    } & Record<string, unknown>;
    expect(body.block_user_connections).toBe(true);
    expect(body.active).toBe(true);
    expect("blocked" in body).toBe(false);
    expect(body.manifest.name).toBe("@myorg/gmail");
    expect(Array.isArray(body.auths)).toBe(true);

    // Persisted on the space_packages row.
    const [row] = await db
      .select({ blocked: spacePackages.blockUserConnections })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, "@myorg/gmail"));
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

    // ctx.user is the org owner — `assertConnectionCreationAllowed` returns
    // early for a holder of `integrations:configure`, so the connect succeeds
    // even with the gate on (this is how the admin creates the shared
    // connection).
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

  it("no longer exempts an owner-minted API KEY — configure is session-only", async () => {
    // Deliberate tightening: the exemption used to read the caller's ROLE, and
    // an API key carries its creator's role, so an owner's key bypassed the
    // gate the org had just turned on. `integrations:configure` is absent from
    // the API-key allowlist, so no key can hold it and the gate now applies.
    await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });

    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id, // owner
      scopes: ["integrations:connect"],
    });

    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("connection_blocked_by_admin");

    // Discriminating control: the same key connects fine once the gate is off,
    // so the 403 is the gate, not the key lacking `integrations:connect`.
    await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: false }),
    });
    const after = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(after.status).toBe(200);
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
// 1b. block_user_connections on an auto-active system integration (no row yet)
// ─────────────────────────────────────────────────────────────────────────

describe("block_user_connections — auto-active system integration", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    // Seed gmail but DO NOT activate it — no space_packages row exists.
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/clickup"));
    // gmail ships a system client → auto-active. clickup does not.
    initSystemIntegrations([
      {
        id: "@myorg/gmail",
        clients: [
          {
            id: "gmail-system",
            auth_key: "google",
            client_id: "sys-client.apps.googleusercontent.com",
            client_secret: "sys-secret",
          },
        ],
      },
    ]);
  });

  afterEach(() => __resetSystemIntegrationsForTest());

  it("materializes a row (enabled stays true) when toggling block on a system integration with no row", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { block_user_connections: boolean; active: boolean };
    expect(body.block_user_connections).toBe(true);
    // Recording the block must NOT deactivate the auto-active integration.
    expect(body.active).toBe(true);

    // Row materialized with enabled=true + block flag set.
    const [row] = await db
      .select({
        enabled: spacePackages.enabled,
        blocked: spacePackages.blockUserConnections,
      })
      .from(spacePackages)
      .where(eq(spacePackages.packageId, "@myorg/gmail"));
    expect(row?.enabled).toBe(true);
    expect(row?.blocked).toBe(true);
  });

  it("404s when toggling block on a non-system integration that is not installed", async () => {
    const res = await app.request("/api/integrations/@myorg/clickup/settings", {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ block_user_connections: true }),
    });
    expect(res.status).toBe(404);
    // Nothing materialized.
    const rows = await db
      .select()
      .from(spacePackages)
      .where(eq(spacePackages.packageId, "@myorg/clickup"));
    expect(rows).toHaveLength(0);
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
    await activate(ctx.defaultSpaceId, "@myorg/gmail");
  });

  /** Insert a connection owned by `userId` in ctx's default space. */
  async function seedConn(opts: {
    userId: string;
    shared?: boolean;
    spaceId?: string;
  }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        spaceId: opts.spaceId ?? ctx.defaultSpaceId,
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
    // 200 + the bare connection resource (#657) — same serializer as the
    // connections list, not the previous hand-built {id,label,…} stub.
    const body = (await res.json()) as {
      id: string;
      packageId: string;
      auth_key: string;
      label: string;
      shared_with_org: boolean;
      owner_type: string;
      createdAt: string;
      updatedAt: string;
    };
    expect(body.label).toBe("My Gmail");
    expect(body.id).toBe(connId);
    expect(body.packageId).toBe("@myorg/gmail");
    expect(body.auth_key).toBe("google");
    expect(body.owner_type).toBe("user");
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");

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
    expect(body.detail ?? "").toMatch(
      /connection owner or a principal with integrations:configure/i,
    );
  });

  it("404s a connection that belongs to a different space", async () => {
    // A second space in the SAME org; the connection lives there, so the
    // route's `ownership.spaceId !== scope.spaceId` check 404s
    // (scope is ctx.defaultSpaceId via the headers).
    const otherSpace = await seedSpace({ orgId: ctx.orgId, name: "Other Space" });
    const connId = await seedConn({ userId: ctx.user.id, spaceId: otherSpace.id });

    const res = await app.request(`/api/integrations/@myorg/gmail/connections/${connId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. integrations:configure is session-only on the governance mutations
// ─────────────────────────────────────────────────────────────────────────

describe("integrations:configure is never grantable to an API key", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await activate(ctx.defaultSpaceId, "@myorg/gmail");
  });

  async function seedSharedConn(): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["openid", "email"],
        sharedWithOrg: true,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("refuses an owner-minted key holding integrations:install on PUT /default", async () => {
    // `integrations:install` is the broadest install-tier scope a key can
    // carry, and only an owner/admin creator can pass it through
    // `resolveApiKeyPermissions`. The governance mutation still 403s because
    // it now requires `integrations:configure`, which is absent from the
    // API-key allowlist and therefore unreachable for any key.
    const connId = await seedSharedConn();
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id, // owner
      scopes: ["integrations:install"],
    });

    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(403);
  });

  it("an owner session still performs the same mutation", async () => {
    // The discriminating half: the route is not simply closed — the same
    // request over a cookie session, which does hold `integrations:configure`,
    // succeeds.
    const connId = await seedSharedConn();
    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connection_id: string };
    expect(body.connection_id).toBe(connId);
  });

  it("validateScopes refuses integrations:configure at mint time, for an owner", async () => {
    expect(() => validateScopes(["integrations:configure"], "owner")).toThrow(
      /non-grantable API key scope/,
    );
    // Same call with a grantable scope proves the throw is about the scope,
    // not about the helper refusing everything.
    expect(validateScopes(["integrations:install"], "owner")).toEqual(["integrations:install"]);
  });

  it("member-created api key requesting integrations:install is stripped to 403", async () => {
    // `resolveApiKeyPermissions` intersects with member grants (which lack
    // install), so the effective set never contains it.
    const connId = await seedSharedConn();
    const member = await createTestUser({ email: "member-key@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
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
    await activate(ctx.defaultSpaceId, "@myorg/gmail");
    // Register the OAuth client so the kickoff can build an authorize URL.
    await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
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
        spaceId: ctx.defaultSpaceId,
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
