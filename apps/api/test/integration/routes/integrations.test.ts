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

describe("GET /api/integrations/:packageId/auths/:authKey/required-scopes", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("returns defaults + empty required/granted when no agent uses the integration", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/required-scopes", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaults: string[];
      required: string[];
      granted: string[];
      union: string[];
      missingFromGranted: string[];
      breakdown: { agentId: string }[];
    };
    expect(body.defaults.sort()).toEqual(["email", "openid"]);
    expect(body.required).toEqual([]);
    expect(body.granted).toEqual([]);
    expect(body.union.sort()).toEqual(["email", "openid"]);
    expect(body.missingFromGranted.sort()).toEqual(["email", "openid"]);
    expect(body.breakdown).toEqual([]);
  });

  it("includes scopes inferred from agent tool selection", async () => {
    // Use a manifest with availableScopes + per-tool requiredScopes for inference.
    const richManifest: IntegrationManifest = {
      manifestVersion: "1.1",
      type: "integration",
      name: "@myorg/gmail-rich",
      version: "1.0.0",
      displayName: "Gmail Rich",
      server: { type: "python", entryPoint: "./server.py" },
      auths: {
        primary: {
          type: "oauth2",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          authorizedUris: ["https://api/*"],
          delivery: { http: {} },
          scopes: [],
          availableScopes: [
            { value: "read", label: "Read" },
            { value: "send", label: "Send" },
          ],
        },
      },
      tools: {
        list_messages: { requiredScopes: ["read"] },
        send_message: { requiredScopes: ["send"] },
      },
    };
    await seedIntegration(ctx.orgId, richManifest);
    await seedPackage({
      id: "@myorg/agent-x",
      orgId: ctx.orgId,
      type: "agent",
      draftManifest: {
        name: "@myorg/agent-x",
        version: "1.0.0",
        type: "agent",
        schemaVersion: "1.0",
        displayName: "X",
        dependencies: { integrations: { "@myorg/gmail-rich": "^1.0.0" } },
        integrations: { "@myorg/gmail-rich": { tools: ["send_message"] } },
      },
    });
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: "@myorg/agent-x",
    });

    const res = await app.request(
      "/api/integrations/@myorg/gmail-rich/auths/primary/required-scopes",
      { headers: authHeaders(ctx) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      required: string[];
      union: string[];
      breakdown: { agentId: string; viaTools: string[] }[];
    };
    expect(body.required).toEqual(["send"]);
    expect(body.union).toEqual(["send"]);
    expect(body.breakdown).toHaveLength(1);
    expect(body.breakdown[0]!.agentId).toBe("@myorg/agent-x");
    expect(body.breakdown[0]!.viaTools).toEqual(["send"]);
  });

  it("reflects existing connection scopes in granted + drops them from missingFromGranted", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await db.insert(integrationConnections).values({
      integrationPackageId: "@myorg/gmail",
      authKey: "google",
      accountId: "acct-1",
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      credentialsEncrypted: "x",
      scopesGranted: ["openid"],
    });

    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/required-scopes", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      granted: string[];
      missingFromGranted: string[];
    };
    expect(body.granted).toEqual(["openid"]);
    expect(body.missingFromGranted).toEqual(["email"]);
  });
});

describe("GET /api/integrations/callback (public — no session required)", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("is reachable without auth and renders popup-close HTML on missing params", async () => {
    // The IdP redirects the browser back to this URL without sending the
    // platform's session cookie reliably (cross-site `SameSite=Lax` may strip
    // it for top-level navigations from third-party origins). The route MUST
    // be in `skipAuth`'s public-paths allowlist; without that the popup is
    // dead-ended on a 401 problem+json instead of closing cleanly.
    const res = await app.request("/api/integrations/callback");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("window.close");
  });

  it("renders an error HTML when the IdP returns ?error=access_denied (still unauthenticated)", async () => {
    const res = await app.request("/api/integrations/callback?error=access_denied");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.close");
    expect(body).toContain("access_denied");
  });
});
