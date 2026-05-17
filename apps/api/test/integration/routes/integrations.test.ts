// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/integrations/*` (INTEGRATIONS_PROPOSAL
 * Phase 1.3 — marketplace UI backend).
 *
 * Covers: list/detail, install/uninstall, OAuth client CRUD, non-OAuth
 * connect (api_key), connections list/delete, and the OAuth2 initiate
 * happy-path (response shape only — the full IdP token exchange is
 * covered hermetically in `packages/connect/test/integration-oauth.test.ts`).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { eq, and } from "drizzle-orm";
import {
  integrationConnections,
  integrationOauthClients,
  applicationPackages,
} from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();

function gmailManifest(name = "@official/gmail"): IntegrationManifest {
  return {
    manifestVersion: "1.0",
    type: "integration",
    name,
    version: "0.1.0",
    displayName: "Gmail",
    description: "Gmail integration",
    server: { type: "node", entryPoint: "main.js" },
    auths: {
      api: {
        type: "api_key",
        authorizedUris: ["https://gmail.googleapis.com/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: {
          http: { headerName: "Authorization", headerPrefix: "Bearer", valueFrom: "api_key" },
        },
      },
      google: {
        type: "oauth2",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scopes: ["openid", "email"],
        authorizedUris: ["https://www.googleapis.com/**"],
        delivery: {
          http: { headerName: "Authorization", headerPrefix: "Bearer", valueFrom: "access_token" },
        },
      },
    },
  };
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

describe("GET /api/integrations", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("returns the org's integrations with `installed: false` by default", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
    expect(body.object).toBe("list");
    const items = body.data as Array<{ id: string; installed: boolean }>;
    const gmail = items.find((i) => i.id === "@myorg/gmail");
    expect(gmail).toBeDefined();
    expect(gmail?.installed).toBe(false);
  });

  it("decorates `installed: true` when the integration is installed in the app", async () => {
    const pkg = await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: pkg.id,
      config: {},
    });
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    const body = (await res.json()) as { data: Array<{ id: string; installed: boolean }> };
    const gmail = body.data.find((i) => i.id === "@myorg/gmail");
    expect(gmail?.installed).toBe(true);
  });
});

describe("GET /api/integrations/:packageId", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("returns the manifest + per-auth status (zero connections, no OAuth client)", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations/@myorg/gmail", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: { name: string };
      auths: Array<{
        authKey: string;
        type: string;
        connections: unknown[];
        hasOAuthClient: boolean;
      }>;
    };
    expect(body.manifest.name).toBe("@myorg/gmail");
    expect(body.auths).toHaveLength(2);
    const api = body.auths.find((a) => a.authKey === "api");
    const google = body.auths.find((a) => a.authKey === "google");
    expect(api?.type).toBe("api_key");
    expect(api?.connections).toHaveLength(0);
    expect(api?.hasOAuthClient).toBe(false);
    expect(google?.type).toBe("oauth2");
    expect(google?.hasOAuthClient).toBe(false);
  });

  it("returns 404 for non-existent integration", async () => {
    const res = await app.request("/api/integrations/@myorg/missing", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST/DELETE /api/integrations/:packageId/install", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("installs and uninstalls the integration in the current app", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const install = await app.request("/api/integrations/@myorg/gmail/install", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(install.status).toBe(201);
    const body = (await install.json()) as { installed: boolean; installedAt: string };
    expect(body.installed).toBe(true);

    const installedRow = await db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@myorg/gmail"),
        ),
      );
    expect(installedRow).toHaveLength(1);

    const uninstall = await app.request("/api/integrations/@myorg/gmail/install", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(uninstall.status).toBe(200);
    const after = await db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@myorg/gmail"),
        ),
      );
    expect(after).toHaveLength(0);
  });

  it("refuses to install a non-integration package as integration (409)", async () => {
    await seedPackage({
      id: "@myorg/agent-x",
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
    });
    const res = await app.request("/api/integrations/@myorg/agent-x/install", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 on duplicate install", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const headers = { ...authHeaders(ctx), "Content-Type": "application/json" };
    const first = await app.request("/api/integrations/@myorg/gmail/install", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(first.status).toBe(201);
    const dup = await app.request("/api/integrations/@myorg/gmail/install", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(dup.status).toBe(409);
  });
});

describe("api_key connection flow", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
  });

  it("stores an api_key connection and surfaces it on GET /:packageId/connections", async () => {
    const post = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(post.status).toBe(200);
    const conn = (await post.json()) as { id: string; authKey: string; accountId: string };
    expect(conn.authKey).toBe("api");
    // No identity extraction declared → accountId falls back to "default"
    expect(conn.accountId).toBe("default");

    const list = await app.request("/api/integrations/@myorg/gmail/connections", {
      headers: authHeaders(ctx),
    });
    const body = (await list.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toContain(conn.id);

    const del = await app.request(`/api/integrations/@myorg/gmail/connections/${conn.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(200);
    const after = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    expect(after).toHaveLength(0);
  });

  it("rejects api_key flow against an oauth2 auth (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { foo: "bar" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty credentials payload (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("OAuth client CRUD", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
  });

  it("registers, reads, rotates, and deletes the OAuth client", async () => {
    // Initially absent
    const initial = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      headers: authHeaders(ctx),
    });
    expect(initial.status).toBe(404);

    // Create
    const put = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "abc", clientSecret: "shh" }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { clientId: string; hasClientSecret: boolean };
    expect(body.clientId).toBe("abc");
    expect(body.hasClientSecret).toBe(true);

    // Read
    const get = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      headers: authHeaders(ctx),
    });
    expect(get.status).toBe(200);

    // Rotate (idempotent upsert)
    const rotate = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "abc", clientSecret: "different" }),
    });
    expect(rotate.status).toBe(200);
    const stored = await db
      .select()
      .from(integrationOauthClients)
      .where(
        and(
          eq(integrationOauthClients.applicationId, ctx.defaultAppId),
          eq(integrationOauthClients.integrationPackageId, "@myorg/gmail"),
          eq(integrationOauthClients.authKey, "google"),
        ),
      );
    expect(stored).toHaveLength(1);

    // Delete
    const del = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(200);
    const after = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationPackageId, "@myorg/gmail"));
    expect(after).toHaveLength(0);
  });

  it("refuses to register an OAuth client against a non-oauth2 auth (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/oauth-clients/api", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "x", clientSecret: "y" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("OAuth2 connect initiate", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
  });

  it("rejects connect when no OAuth client is registered (403)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("returns a PKCE-protected authorize URL after registering OAuth client", async () => {
    // Register OAuth client first
    await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "abc", clientSecret: "shh" }),
    });
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string; state: string };
    const url = new URL(body.authUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(body.state).toBeString();
  });

  it("rejects against a non-oauth2 auth (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });
});
