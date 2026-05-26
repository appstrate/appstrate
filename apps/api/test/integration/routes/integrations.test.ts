// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `/api/integrations/*` (INTEGRATIONS_PROPOSAL
 * Phase 1.3 — marketplace UI backend).
 *
 * Covers: list/detail, activate/deactivate, OAuth client CRUD, non-OAuth
 * connect (api_key), connections list/delete, and the OAuth2 initiate
 * happy-path (response shape only — the full IdP token exchange is
 * covered hermetically in `packages/connect/test/integration-oauth.test.ts`).
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
    type: "integration",
    schema_version: "2.0",
    name,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    // AFPS 2.0: local server → mcp-server reference (separate package).
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      api: {
        type: "api_key",
        authorized_uris: ["https://gmail.googleapis.com/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer",
            value: "{$credential.api_key}",
          },
        },
      },
      google: {
        type: "oauth2",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        default_scopes: ["openid", "email"],
        authorized_uris: ["https://www.googleapis.com/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer",
            value: "{$credential.access_token}",
          },
        },
      },
    },
  } as unknown as IntegrationManifest;
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

  it("returns the org's integrations with `active: false` by default", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
    expect(body.object).toBe("list");
    const items = body.data as Array<{ id: string; active: boolean }>;
    const gmail = items.find((i) => i.id === "@myorg/gmail");
    expect(gmail).toBeDefined();
    expect(gmail?.active).toBe(false);
  });

  it("decorates `active: true` when the integration is activated in the app", async () => {
    const pkg = await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: pkg.id,
      config: {},
    });
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    const body = (await res.json()) as { data: Array<{ id: string; active: boolean }> };
    const gmail = body.data.find((i) => i.id === "@myorg/gmail");
    expect(gmail?.active).toBe(true);
  });
});

describe("GET /api/integrations/:packageId", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("returns the manifest + per-auth status + tool catalog", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations/@myorg/gmail", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manifest: { name: string };
      auths: Array<{
        auth_key: string;
        type: string;
        connections: unknown[];
        has_oauth_client: boolean;
      }>;
      tool_catalog: Array<{ name: string; description?: string; policy?: unknown }>;
    };
    expect(body.manifest.name).toBe("@myorg/gmail");
    expect(body.auths).toHaveLength(2);
    const api = body.auths.find((a) => a.auth_key === "api");
    const google = body.auths.find((a) => a.auth_key === "google");
    expect(api?.type).toBe("api_key");
    expect(api?.connections).toHaveLength(0);
    expect(api?.has_oauth_client).toBe(false);
    expect(google?.type).toBe("oauth2");
    expect(google?.has_oauth_client).toBe(false);
    // The gmail fixture has no referenced mcp-server seeded → resolver
    // falls back to the integration's `tools` keys. Shape assertion keeps
    // the contract present without coupling to fixture catalog edits.
    expect(Array.isArray(body.tool_catalog)).toBe(true);
  });

  it("returns 404 for non-existent integration", async () => {
    const res = await app.request("/api/integrations/@myorg/missing", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/integrations/:packageId/activate + DELETE .../deactivate", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  it("activates and deactivates the integration in the current app", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const activate = await app.request("/api/integrations/@myorg/gmail/activate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(activate.status).toBe(201);
    const body = (await activate.json()) as { active: boolean; activatedAt: string };
    expect(body.active).toBe(true);

    const activeRow = await db
      .select()
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@myorg/gmail"),
        ),
      );
    expect(activeRow).toHaveLength(1);

    const deactivate = await app.request("/api/integrations/@myorg/gmail/deactivate", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(deactivate.status).toBe(200);
    const deactivateBody = (await deactivate.json()) as { active: boolean };
    expect(deactivateBody.active).toBe(false);
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

  it("refuses to activate a non-integration package as integration (409)", async () => {
    await seedPackage({
      id: "@myorg/agent-x",
      orgId: ctx.orgId,
      type: "agent",
      source: "local",
    });
    const res = await app.request("/api/integrations/@myorg/agent-x/activate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 on duplicate activate", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const headers = { ...authHeaders(ctx), "Content-Type": "application/json" };
    const first = await app.request("/api/integrations/@myorg/gmail/activate", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(first.status).toBe(201);
    const dup = await app.request("/api/integrations/@myorg/gmail/activate", {
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
    const conn = (await post.json()) as { id: string; auth_key: string; account_id: string };
    expect(conn.auth_key).toBe("api");
    // No identity extraction declared → account_id falls back to "default"
    expect(conn.account_id).toBe("default");

    const list = await app.request("/api/integrations/@myorg/gmail/connections", {
      headers: authHeaders(ctx),
    });
    const body = (await list.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).toContain(conn.id);

    // Destructive delete moved to /me/connections/:id (single owner-scoped
    // entry point — see C7 of the integration refactor). The legacy
    // /integrations/:packageId/connections/:id route was removed in lockstep.
    const del = await app.request(`/api/me/connections/${conn.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);
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

describe("api_key credentials schema validation (delivery.http silent-no-op guard)", () => {
  let ctx: TestContext;

  // A manifest whose api_key auth declares `required: ["api_key"]` — the shape
  // the silent-no-op bug needs to be caught (key-casing mismatch leaves the
  // required field absent, so `delivery.http` injection resolves to "").
  function strictManifest(name = "@myorg/strict"): IntegrationManifest {
    const m = gmailManifest(name);
    m.auths!.api!.credentials = {
      schema: {
        type: "object",
        required: ["api_key"],
        properties: { api_key: { type: "string" } },
      },
    };
    return m;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, strictManifest("@myorg/strict"));
  });

  it("rejects a wrong-cased credential key that misses the required field (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/strict/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      // `apiKey` (camelCase) instead of the declared `api_key` (snake_case):
      // would otherwise persist a healthy-looking connection whose injection
      // silently no-ops at runtime.
      body: JSON.stringify({ credentials: { apiKey: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(400);
    // Nothing persisted.
    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationPackageId, "@myorg/strict"));
    expect(rows).toHaveLength(0);
  });

  it("accepts the correctly-cased credential key (200)", async () => {
    const res = await app.request("/api/integrations/@myorg/strict/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET" } }),
    });
    expect(res.status).toBe(200);
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
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { client_id: string; has_client_secret: boolean };
    expect(body.client_id).toBe("abc");
    expect(body.has_client_secret).toBe(true);

    // Read
    const get = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      headers: authHeaders(ctx),
    });
    expect(get.status).toBe(200);

    // Rotate (idempotent upsert)
    const rotate = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "abc", client_secret: "different" }),
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
      body: JSON.stringify({ client_id: "x", client_secret: "y" }),
    });
    expect(res.status).toBe(400);
  });

  it("forbids a non-admin member from persisting an OAuth client secret (403)", async () => {
    // PUT .../oauth-clients/:authKey requires `integrations:install`, which
    // the `member` role does not hold (it only has read/connect/disconnect).
    // Persisting a clientSecret must therefore be admin-gated.
    const member = await createTestUser({ email: "oauth-member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const memberHeaders = {
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
      "Content-Type": "application/json",
    };
    const res = await app.request("/api/integrations/@myorg/gmail/oauth-clients/google", {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
    });
    expect(res.status).toBe(403);
    // Nothing persisted.
    const rows = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationPackageId, "@myorg/gmail"));
    expect(rows).toHaveLength(0);
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
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
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

  it("rejects an unknown/forged state (CSRF guard — state never written to the store)", async () => {
    // The `state` value is the CSRF binding: oauth-state-store.set() at
    // kickoff persists it, get() at callback consumes-once. Replaying a
    // state that was never persisted (or was already consumed) must NOT
    // dispatch token exchange — that's the whole CSRF protection.
    //
    // handleIntegrationOAuthCallback throws OAuthCallbackError("transient")
    // when `store.get(state)` returns null; the route renders the
    // generic "Could not complete the connection" popup HTML (NOT the
    // "expired" variant — that's keyed on `kind === "revoked"`).
    const res = await app.request(
      "/api/integrations/callback?code=any-code&state=forged-state-never-stored",
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // popup HTML is rendered (window.close present), with the generic
    // user-facing transient error — the forged state was REFUSED, not
    // silently exchanged.
    expect(body).toContain("window.close");
    expect(body).toMatch(/Could not complete the connection|try again/i);
    // Sanity foil: a token-exchange success would have shown a clean
    // close with no error text.
    expect(body).not.toContain("access_denied");
  });

  it("rejects an empty state value (cannot bypass CSRF by omitting state)", async () => {
    // ?code=… without ?state=… — caller is treated as missing-params, not
    // exchanged. The route's pre-handler guard at `if (!code || !state)`
    // is the first line of defence.
    const res = await app.request("/api/integrations/callback?code=any-code&state=");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.close");
    expect(body).toMatch(/Missing required parameters|try again/i);
  });
});

describe("GET/PUT/DELETE /api/integrations/:packageId/default (org default connection)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
  });

  /** Insert a connection owned by the org owner. `shared` toggles sharedWithOrg. */
  async function seedConn(shared: boolean): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationPackageId: "@myorg/gmail",
        authKey: "google",
        accountId: "acct-1",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: ["openid", "email"],
        sharedWithOrg: shared,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("returns { default: null } when none is set", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ default: null });
  });

  it("upserts a soft default and reads it back", async () => {
    const connId = await seedConn(true);
    const put = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(put.status).toBe(200);
    const created = (await put.json()) as { connection_id: string; enforce: boolean };
    expect(created.connection_id).toBe(connId);
    expect(created.enforce).toBe(false);

    const get = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    const body = (await get.json()) as {
      default: { connection_id: string; enforce: boolean } | null;
    };
    expect(body.default?.connection_id).toBe(connId);
  });

  it("upsert replaces the existing default (one row per integration) and honors enforce", async () => {
    const a = await seedConn(true);
    const b = await seedConn(true);
    await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: a }),
    });
    const put2 = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: b, enforce: true }),
    });
    expect(put2.status).toBe(200);
    const get = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    const body = (await get.json()) as { default: { connection_id: string; enforce: boolean } };
    expect(body.default.connection_id).toBe(b);
    expect(body.default.enforce).toBe(true);
  });

  it("refuses a connection that is not sharedWithOrg (400)", async () => {
    const connId = await seedConn(false);
    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes the default", async () => {
    const connId = await seedConn(true);
    await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_id: connId }),
    });
    const del = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    const get = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    expect((await get.json()) as { default: null }).toEqual({ default: null });
  });

  it("forbids a non-admin member from setting the default (403)", async () => {
    const connId = await seedConn(true);
    const member = await createTestUser({ email: "member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const memberHeaders = {
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
      "Content-Type": "application/json",
    };
    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      method: "PUT",
      headers: memberHeaders,
      body: JSON.stringify({ connection_id: connId }),
    });
    expect(res.status).toBe(403);
  });
});
