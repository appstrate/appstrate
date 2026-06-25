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
import { seedPackage } from "../../helpers/seed.ts";
import { eq, and } from "drizzle-orm";
import {
  integrationConnections,
  integrationOauthClients,
  applicationPackages,
} from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";

const app = getTestApp();

function gmailManifest(name = "@official/gmail"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    // AFPS: local server → mcp-server reference (separate package).
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    // AFPS §4.4 — the tool an agent inherits without an explicit selection.
    // Surfaced by the detail endpoint so an agent-builder sees the default.
    default_tools: ["api_call"],
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

/**
 * Remote MCP integration (AFPS `source.kind: "remote"`) mirroring the real
 * `@appstrate/clickup-mcp` / `@appstrate/notion-mcp` connectors: an oauth2 auth
 * that declares an `issuer` (AFPS §7.3 still requires issuer-or-endpoints) but
 * NO pre-registered client. The connect flow discovers the AS (RFC 9728 → RFC
 * 8414) and self-registers via RFC 7591 DCR. The `.invalid` TLD (RFC 6761)
 * guarantees discovery fails fast (NXDOMAIN) so the connect path is exercised
 * without a live authorization server.
 */
function remoteMcpManifest(name = "@myorg/remote-mcp"): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "1.0.0",
    display_name: "Remote MCP",
    description: "Remote MCP integration with MCP-spec auto-DCR",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
    },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://mcp.invalid",
        // Public client (PKCE, no secret) — the MCP-spec norm that marks this
        // auth as client-auto-provisioned (CIMD/DCR).
        token_endpoint_auth_method: "none",
        default_scopes: ["read", "write"],
        authorized_uris: ["https://mcp.invalid/**"],
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.access_token}",
          },
        },
        _meta: { "dev.appstrate/oauth": { scope_separator: " " } },
      },
      api: {
        type: "api_key",
        authorized_uris: ["https://mcp.invalid/**"],
        credentials: { schema: { type: "object", properties: { api_key: { type: "string" } } } },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.api_key}",
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
  afterEach(() => __resetSystemIntegrationsForTest());

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

  it("decorates `active: true` for a system integration with no install row", async () => {
    // A SYSTEM_INTEGRATIONS entry makes the integration auto-active out
    // of the box — no application_packages row required.
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
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
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    const body = (await res.json()) as { data: Array<{ id: string; active: boolean }> };
    const gmail = body.data.find((i) => i.id === "@myorg/gmail");
    expect(gmail?.active).toBe(true);
  });

  it("decorates `active: false` when a system integration is explicitly disabled", async () => {
    // Sticky opt-out: a disabled install row wins over the system-client
    // auto-active default, and never silently re-activates.
    const pkg = await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
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
    await db.insert(applicationPackages).values({
      applicationId: ctx.defaultAppId,
      packageId: pkg.id,
      config: {},
      enabled: false,
    });
    const res = await app.request("/api/integrations", { headers: authHeaders(ctx) });
    const body = (await res.json()) as { data: Array<{ id: string; active: boolean }> };
    const gmail = body.data.find((i) => i.id === "@myorg/gmail");
    expect(gmail?.active).toBe(false);
  });

  it("projects only requested fields, dropping the heavy manifest", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations?fields=id,source", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const gmail = body.data.find((i) => i.id === "@myorg/gmail");
    expect(gmail).toBeDefined();
    expect(Object.keys(gmail!).sort()).toEqual(["id", "source"]);
    expect(gmail).not.toHaveProperty("manifest");
  });

  it("rejects an unknown field in the selector with 400", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const res = await app.request("/api/integrations?fields=id,nope", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("invalid_request");
    expect(body.detail).toContain("nope");
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
        client_auto_provisioned: boolean;
      }>;
      tool_catalog: Array<{ name: string; description?: string; policy?: unknown }>;
      default_tools?: string[] | "*";
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
    // Local-source oauth2 → no auto-provisioning (endpoints are manifest-
    // declared and a client must be pre-registered).
    expect(google?.client_auto_provisioned).toBe(false);
    // The gmail fixture has no referenced mcp-server seeded → resolver
    // falls back to the integration's `tools` keys. Shape assertion keeps
    // the contract present without coupling to fixture catalog edits.
    expect(Array.isArray(body.tool_catalog)).toBe(true);
    // AFPS §4.4 — the manifest's declared default_tools is surfaced verbatim
    // so an agent-builder sees what tools it inherits without selecting any.
    expect(body.default_tools).toEqual(["api_call"]);
  });

  it("flags has_system_client when a shared platform client serves the oauth2 auth", async () => {
    // A SYSTEM_INTEGRATIONS entry for (integration, auth) makes the auth
    // connectable out of the box — connect falls back to it without an
    // org-registered client. The detail must surface that so the UI unlocks the
    // connect button (the model-provider system-key fallback, mirrored).
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
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
    try {
      const res = await app.request("/api/integrations/@myorg/gmail", {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        auths: Array<{ auth_key: string; has_oauth_client: boolean; has_system_client: boolean }>;
      };
      const google = body.auths.find((a) => a.auth_key === "google");
      const api = body.auths.find((a) => a.auth_key === "api");
      // oauth2 auth with a matching system client → connectable, no org client.
      expect(google?.has_system_client).toBe(true);
      expect(google?.has_oauth_client).toBe(false);
      // The api_key auth carries no client; the system client targets `google` only.
      expect(api?.has_system_client).toBe(false);
    } finally {
      __resetSystemIntegrationsForTest();
    }
  });

  it("returns 404 for non-existent integration", async () => {
    const res = await app.request("/api/integrations/@myorg/missing", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("flags a remote MCP oauth2 auth as client_auto_provisioned", async () => {
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const res = await app.request("/api/integrations/@myorg/remote-mcp", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: Array<{
        auth_key: string;
        type: string;
        has_oauth_client: boolean;
        client_auto_provisioned: boolean;
      }>;
    };
    const oauth = body.auths.find((a) => a.auth_key === "oauth");
    const api = body.auths.find((a) => a.auth_key === "api");
    // oauth2 on a remote MCP integration → client auto-provisioned, connectable
    // without a pre-registered client.
    expect(oauth?.type).toBe("oauth2");
    expect(oauth?.has_oauth_client).toBe(false);
    expect(oauth?.client_auto_provisioned).toBe(true);
    // api_key is not oauth2 → no auto-provisioning (it carries no client at all).
    expect(api?.type).toBe("api_key");
    expect(api?.client_auto_provisioned).toBe(false);
  });

  it("a confidential remote MCP oauth2 is NOT client_auto_provisioned (needs a registered client)", async () => {
    // Mirrors the github-mcp / gmail-mcp connectors: remote source, but a
    // confidential client (`client_secret_post`) with explicit endpoints. Such
    // an auth expects an admin-registered client and must NOT be flagged
    // auto-provisioned just because the source is remote.
    const confidentialRemote = {
      type: "integration",
      schema_version: "0.1",
      name: "@myorg/remote-confidential",
      version: "1.0.0",
      display_name: "Remote confidential",
      source: {
        kind: "remote",
        remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
      },
      auths: {
        oauth: {
          type: "oauth2",
          authorization_endpoint: "https://mcp.invalid/oauth/authorize",
          token_endpoint: "https://mcp.invalid/oauth/token",
          token_endpoint_auth_method: "client_secret_post",
          default_scopes: ["read"],
          authorized_uris: ["https://mcp.invalid/**"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
        },
      },
    } as unknown as IntegrationManifest;
    await seedIntegration(ctx.orgId, confidentialRemote);
    const res = await app.request("/api/integrations/@myorg/remote-confidential", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      auths: Array<{ auth_key: string; client_auto_provisioned: boolean }>;
    };
    const oauth = body.auths.find((a) => a.auth_key === "oauth");
    expect(oauth?.client_auto_provisioned).toBe(false);
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
    const body = (await activate.json()) as {
      active: boolean;
      block_user_connections: boolean;
      manifest: { name: string };
      auths: unknown[];
      tool_catalog: unknown[];
      allow_undeclared_tools: boolean;
    } & Record<string, unknown>;
    // 201 + the bare integration detail resource (#657): same shape as
    // GET /:packageId — activation state is the resource's `active` field,
    // no `activated_at` operation scrap.
    expect(body.active).toBe(true);
    expect(body.block_user_connections).toBe(false);
    expect("activated_at" in body).toBe(false);
    expect(body.manifest.name).toBe("@myorg/gmail");
    expect(Array.isArray(body.auths)).toBe(true);
    expect(Array.isArray(body.tool_catalog)).toBe(true);
    expect(typeof body.allow_undeclared_tools).toBe("boolean");

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
    // DELETE → 204 empty (#657): deactivation flips `enabled` to false (the
    // row persists — it is the explicit opt-out, not a delete). The detail
    // stays GET-able afterwards and serves `active: false`.
    expect(deactivate.status).toBe(204);
    expect(await deactivate.text()).toBe("");

    const detailAfter = await app.request("/api/integrations/@myorg/gmail", {
      headers: authHeaders(ctx),
    });
    expect(detailAfter.status).toBe(200);
    const detailBody = (await detailAfter.json()) as {
      active: boolean;
      manifest: { name: string };
      auths: unknown[];
      tool_catalog: unknown[];
      allow_undeclared_tools: boolean;
    };
    expect(detailBody.active).toBe(false);
    expect(detailBody.manifest.name).toBe("@myorg/gmail");
    expect(Array.isArray(detailBody.auths)).toBe(true);
    expect(Array.isArray(detailBody.tool_catalog)).toBe(true);
    expect(typeof detailBody.allow_undeclared_tools).toBe("boolean");
    // The row survives, flagged disabled — this is the sticky opt-out, not a
    // delete (deleting would let a system integration re-trigger auto-active).
    const after = await db
      .select({ enabled: applicationPackages.enabled })
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@myorg/gmail"),
        ),
      );
    expect(after).toHaveLength(1);
    expect(after[0]?.enabled).toBe(false);
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

  it("is idempotent on repeat activate", async () => {
    // Activation is a flag upsert (enabled=true), so re-activating an already
    // active integration is a no-op success — not a 409. This is what lets a
    // disabled (opt-out) integration be re-activated cleanly.
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
    expect(dup.status).toBe(201);

    // Exactly one row, enabled.
    const rows = await db
      .select({ enabled: applicationPackages.enabled })
      .from(applicationPackages)
      .where(
        and(
          eq(applicationPackages.applicationId, ctx.defaultAppId),
          eq(applicationPackages.packageId, "@myorg/gmail"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });

  it("re-activates a deactivated integration (opt-out cleared)", async () => {
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    const headers = { ...authHeaders(ctx), "Content-Type": "application/json" };
    await app.request("/api/integrations/@myorg/gmail/activate", {
      method: "POST",
      headers,
      body: "{}",
    });
    await app.request("/api/integrations/@myorg/gmail/deactivate", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    const reactivate = await app.request("/api/integrations/@myorg/gmail/activate", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(reactivate.status).toBe(201);
    const body = (await reactivate.json()) as { active: boolean };
    expect(body.active).toBe(true);
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
    // entry point). The legacy
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

  it("renews an api_key connection in place when connection_id is supplied — no duplicate", async () => {
    // The renew CTA (MissingConnectionsModal / status cards) forwards the dead
    // connection's id on the fields flow so the write UPDATEs that row instead
    // of INSERTing a duplicate (single-writer contract). Without the route
    // threading connection_id into the strategy ctx, a non-OAuth renew left the
    // dead row behind and the 412 modal never cleared its CTA.
    const first = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-FIRST" } }),
    });
    expect(first.status).toBe(200);
    const created = (await first.json()) as { id: string };

    const renew = await app.request("/api/integrations/@myorg/gmail/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: { api_key: "AKIA-RENEWED" },
        connection_id: created.id,
      }),
    });
    expect(renew.status).toBe(200);
    const renewed = (await renew.json()) as { id: string };
    expect(renewed.id).toBe(created.id);

    const rows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    expect(rows).toHaveLength(1);
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
      .where(eq(integrationConnections.integrationId, "@myorg/strict"));
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

// R8b — connectFieldsSchema accepts JSON-typed credentials (not string-only)
describe("connectFieldsSchema — non-string credential values (R8b)", () => {
  let ctx: TestContext;

  /**
   * A manifest whose api_key auth accepts a numeric `port`, a boolean `tls`,
   * and an object `metadata` alongside the string `api_key`. JSON Schema
   * 2020-12 §7.5 permits any JSON type for credential values; the route-layer
   * Zod schema must not narrow to `Record<string, string>`.
   */
  function mixedTypeManifest(name = "@myorg/mixed"): IntegrationManifest {
    return {
      type: "integration",
      schema_version: "0.1",
      name,
      version: "0.1.0",
      display_name: "Mixed",
      source: { kind: "local", server: { name, version: "^0.1.0" } },
      auths: {
        api: {
          type: "api_key",
          authorized_uris: ["https://api.example.com/**"],
          credentials: {
            schema: {
              type: "object",
              required: ["api_key"],
              properties: {
                api_key: { type: "string" },
                port: { type: "number" },
                tls: { type: "boolean" },
                metadata: { type: "object" },
              },
            },
          },
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.api_key}",
            },
          },
        },
      },
    };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, mixedTypeManifest("@myorg/mixed"));
  });

  it("accepts a numeric credential value (Zod no longer narrows to string)", async () => {
    const res = await app.request("/api/integrations/@myorg/mixed/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET", port: 5432 } }),
    });
    expect(res.status).toBe(200);
  });

  it("accepts a boolean credential value", async () => {
    const res = await app.request("/api/integrations/@myorg/mixed/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "AKIA-SECRET", tls: true } }),
    });
    expect(res.status).toBe(200);
  });

  it("accepts an object credential value", async () => {
    const res = await app.request("/api/integrations/@myorg/mixed/auths/api/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: { api_key: "AKIA-SECRET", metadata: { region: "us-east-1" } },
      }),
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

  /** Register a custom client via the create route; return its id. */
  async function createClient(
    clientId: string,
    clientSecret: string,
  ): Promise<{ status: number; id: string }> {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    const body = res.status === 201 ? ((await res.json()) as { id?: string }) : {};
    return { status: res.status, id: body.id ?? "" };
  }

  async function listClients(): Promise<
    Array<{ client_ref: string; source: string; is_default: boolean; client_id: string }>
  > {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/clients", {
      headers: authHeaders(ctx),
    });
    const body = (await res.json()) as {
      data: Array<{ client_ref: string; source: string; is_default: boolean; client_id: string }>;
    };
    return body.data;
  }

  it("returns 404 listing clients for an unknown integration (no empty-list leak)", async () => {
    const res = await app.request("/api/integrations/@myorg/nonexistent/auths/google/clients", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("creates, lists, rotates, and deletes a custom OAuth client", async () => {
    // Create
    const created = await createClient("abc", "shh");
    expect(created.status).toBe(201);
    expect(created.id).not.toBe("");

    // List — the custom client is present and is the default.
    let clients = await listClients();
    const custom = clients.find((c) => c.source === "custom");
    expect(custom).toMatchObject({ client_id: "abc", is_default: true });

    // Rotate by id
    const rotate = await app.request(`/api/integrations/@myorg/gmail/oauth-clients/${created.id}`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "abc2", client_secret: "different" }),
    });
    expect(rotate.status).toBe(200);
    clients = await listClients();
    expect(clients.find((c) => c.source === "custom")?.client_id).toBe("abc2");

    // Delete by id
    const del = await app.request(`/api/integrations/@myorg/gmail/oauth-clients/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);
    const after = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, "@myorg/gmail"));
    expect(after).toHaveLength(0);
  });

  it("deleting a client cascades: connections pinned to it are deleted, others survive", async () => {
    const target = await createClient("target", "s1");
    const other = await createClient("other", "s2");

    // Two connections pinned to `target` + one pinned to `other`. The `other`
    // one is the control: it must survive the `target` delete.
    await db.insert(integrationConnections).values([
      {
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "a@x.test",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "enc",
        clientRef: target.id,
      },
      {
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "b@x.test",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "enc",
        clientRef: target.id,
      },
      {
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "c@x.test",
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        credentialsEncrypted: "enc",
        clientRef: other.id,
      },
    ]);

    const del = await app.request(`/api/integrations/@myorg/gmail/oauth-clients/${target.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);

    const conns = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, "@myorg/gmail"));
    // The two `target` connections are gone; the `other` one remains.
    expect(conns).toHaveLength(1);
    expect(conns[0]?.clientRef).toBe(other.id);
  });

  it("registers N custom clients; only the first is default; set-default flips", async () => {
    const a = await createClient("client-a", "sa");
    const b = await createClient("client-b", "sb");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    let clients = await listClients();
    const customs = clients.filter((c) => c.source === "custom");
    expect(customs).toHaveLength(2);
    // First registered wins the default; exactly one is default.
    expect(customs.filter((c) => c.is_default)).toHaveLength(1);
    expect(clients.find((c) => c.is_default)?.client_ref).toBe(a.id);

    // Promote the second.
    const setDefault = await app.request(
      "/api/integrations/@myorg/gmail/auths/google/default-client",
      {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_ref: b.id }),
      },
    );
    expect(setDefault.status).toBe(200);
    clients = await listClients();
    expect(clients.find((c) => c.is_default)?.client_ref).toBe(b.id);
    // Still exactly one default (the one-default invariant holds).
    expect(clients.filter((c) => c.source === "custom" && c.is_default)).toHaveLength(1);
  });

  it("rejects setting an unknown client_ref as default (400, no silent fallback)", async () => {
    await createClient("client-a", "sa");
    // A well-formed-but-unregistered UUID resolves to neither a custom row nor a
    // system client → the route must 400, never silently keep/clear the default.
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/default-client", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_ref: "11111111-1111-4111-8111-111111111111" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects pinning another application's custom client as default (cross-app escalation, 400)", async () => {
    const a = await createClient("client-a", "sa"); // ctx's own client (the default)
    // A client owned by a DIFFERENT org/application for the same (global)
    // integration package. Inserted directly so it's genuinely foreign-scoped.
    const otherCtx = await createTestContext({ orgSlug: "other" });
    const [foreign] = await db
      .insert(integrationOauthClients)
      .values({
        applicationId: otherCtx.defaultAppId,
        integrationId: "@myorg/gmail",
        authKey: "google",
        clientId: "foreign",
        clientSecretEncrypted: "enc",
      })
      .returning({ id: integrationOauthClients.id });

    // ctx's app must not be able to pin the foreign-app client as its default —
    // the resolver scopes custom rows to (applicationId, integration, auth).
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/default-client", {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_ref: foreign!.id }),
    });
    expect(res.status).toBe(400);

    // ctx's own default is untouched by the rejected cross-app attempt.
    const clients = await listClients();
    expect(clients.find((c) => c.is_default)?.client_ref).toBe(a.id);
  });

  it("deleting the default custom client falls back to no custom default", async () => {
    const a = await createClient("client-a", "sa");
    await createClient("client-b", "sb");
    // `a` is the default; delete it.
    const del = await app.request(`/api/integrations/@myorg/gmail/oauth-clients/${a.id}`, {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(del.status).toBe(204);
    // No auto-promotion — the remaining custom is NOT silently made default.
    const clients = await listClients();
    const customs = clients.filter((c) => c.source === "custom");
    expect(customs).toHaveLength(1);
    // With no system client and no flagged default, the list still surfaces a
    // default (first custom as connectable fallback) — but no row carries the
    // is_default DB flag, so a fresh delete didn't promote anyone.
    const rows = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, "@myorg/gmail"));
    expect(rows.filter((r) => r.isDefault)).toHaveLength(0);
  });

  it("rejects rotating an unknown client id (404)", async () => {
    const res = await app.request(
      "/api/integrations/@myorg/gmail/oauth-clients/11111111-1111-4111-8111-111111111111",
      {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "x", client_secret: "y" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a non-UUID client id on the by-id routes (404)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/oauth-clients/not-a-uuid", {
      method: "DELETE",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("refuses to register an OAuth client against a non-oauth2 auth (400)", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/api/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "x", client_secret: "y" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a manual client on an auto-provisioned (remote MCP) auth (400)", async () => {
    // The auto-DCR auth's token endpoint only accepts a public client acquired
    // via DCR/CIMD; a hand-entered client_id points at the wrong OAuth server
    // and, once stored, silently disables auto-registration. The create route
    // must reject it (mirrors the UI hiding the form) so the trap can't be
    // created via curl either.
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const res = await app.request("/api/integrations/@myorg/remote-mcp/auths/oauth/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "L8NTR0830JX39XG8MWYFZ9ZV0WBARPLR", client_secret: "x" }),
    });
    expect(res.status).toBe(400);
    // Nothing persisted — DCR stays the only path.
    const rows = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, "@myorg/remote-mcp"));
    expect(rows).toHaveLength(0);
  });

  it("forbids a non-admin member from persisting an OAuth client secret (403)", async () => {
    // POST .../oauth-clients requires `integrations:install`, which the `member`
    // role does not hold (it only has read/connect/disconnect). Persisting a
    // clientSecret must therefore be admin-gated.
    const member = await createTestUser({ email: "oauth-member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const memberHeaders = {
      Cookie: member.cookie,
      "X-Org-Id": ctx.orgId,
      "X-Application-Id": ctx.defaultAppId,
      "Content-Type": "application/json",
    };
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
      headers: memberHeaders,
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
    });
    expect(res.status).toBe(403);
    // Nothing persisted.
    const rows = await db
      .select()
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.integrationId, "@myorg/gmail"));
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

  it("remote MCP oauth2 with no pre-registered client takes the auto-DCR path (403 when discovery fails)", async () => {
    // A remote MCP integration self-registers its client at connect time, so
    // connect is attempted even with no pre-registered client (unlike a classic
    // oauth2 auth, which the UI gates earlier). Discovery against the
    // unreachable `.invalid` AS yields no registration_endpoint, so DCR is a
    // best-effort no-op and the flow falls back to the "no client" 403 — never
    // throwing. Exercises the remote auto-DCR branch end-to-end.
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const res = await app.request(
      "/api/integrations/@myorg/remote-mcp/auths/oauth/connect/oauth2",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(res.status).toBe(403);
    // The error names the specific provisioning failure (no registration
    // endpoint discovered against the unreachable AS) and carries its remedy.
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("did not advertise dynamic client registration");
    expect(body.detail).toContain("register an OAuth client manually");
  });

  it("returns a PKCE-protected authorize URL after registering OAuth client", async () => {
    // Register OAuth client first
    await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "abc", client_secret: "shh" }),
    });
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string; state: string };
    const url = new URL(body.auth_url);
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
        integrationId: "@myorg/gmail",
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

  it("returns 204 when none is set", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
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
    expect(get.status).toBe(200);
    const body = (await get.json()) as { connection_id: string; enforce: boolean };
    expect(body.connection_id).toBe(connId);
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
    const body = (await get.json()) as { connection_id: string; enforce: boolean };
    expect(body.connection_id).toBe(b);
    expect(body.enforce).toBe(true);
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
    expect(del.status).toBe(204);
    const get = await app.request("/api/integrations/@myorg/gmail/default", {
      headers: authHeaders(ctx),
    });
    expect(get.status).toBe(204);
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

describe("multi-client: list + system-client connect", () => {
  let ctx: TestContext;
  const SYSTEM_ID = "gmail-system";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, gmailManifest("@myorg/gmail"));
    __resetSystemIntegrationsForTest();
  });

  afterEach(() => __resetSystemIntegrationsForTest());

  function seedSystem() {
    initSystemIntegrations([
      {
        id: "@myorg/gmail",
        clients: [
          {
            id: SYSTEM_ID,
            auth_key: "google",
            client_id: "sys-client.apps.googleusercontent.com",
            client_secret: "sys-secret",
          },
        ],
      },
    ]);
  }

  async function listClients() {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/clients", {
      headers: authHeaders(ctx),
    });
    return res;
  }

  it("GET clients returns an empty list when nothing is configured", async () => {
    const res = await listClients();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe("list");
    expect(body.data).toEqual([]);
  });

  it("GET clients surfaces the system client as default, no secret", async () => {
    seedSystem();
    const res = await listClients();
    const body = (await res.json()) as {
      data: Array<{ client_ref: string; source: string; is_default: boolean; client_id: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      client_ref: "gmail-system",
      source: "built-in",
      is_default: true,
    });
    expect(JSON.stringify(body.data)).not.toContain("sys-secret");
    // Neither the secret NOR the real system client_id leaks — the descriptor
    // returns an opaque `sys_` fingerprint for system clients.
    expect(JSON.stringify(body.data)).not.toContain("sys-client.apps.googleusercontent.com");
    expect(body.data[0]!.client_id).toMatch(/^sys_[0-9a-f]{16}$/);
  });

  it("GET clients lists custom (default) + system once an org registers its own app", async () => {
    seedSystem();
    const put = await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "org-client", client_secret: "org-secret" }),
    });
    expect(put.status).toBe(201);

    const body = (await (await listClients()).json()) as {
      data: Array<{ client_ref: string; source: string; is_default: boolean }>;
    };
    expect(body.data).toHaveLength(2);
    const custom = body.data.find((c) => c.source === "custom")!;
    // The custom client_ref is the per-application row id (a UUID), not a sentinel.
    expect(custom.is_default).toBe(true);
    expect(custom.client_ref).not.toBe("gmail-system");
    expect(custom.client_ref.length).toBeGreaterThan(0);
    expect(body.data.find((c) => c.source === "built-in")).toMatchObject({
      client_ref: "gmail-system",
      is_default: false,
    });
  });

  it("connects with the system client out of the box (no per-org client registered)", async () => {
    seedSystem();
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string; state: string };
    // The authorize URL carries the SYSTEM client_id — the shared app.
    expect(body.auth_url).toContain("client_id=sys-client.apps.googleusercontent.com");
    expect(body.state).toBeTruthy();
  });

  it("still 403s when neither a custom nor a system client exists", async () => {
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("connects with the org's custom client by default when one is registered", async () => {
    seedSystem();
    await app.request("/api/integrations/@myorg/gmail/auths/google/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "org-client", client_secret: "org-secret" }),
    });
    // No per-connect picker — the first registered custom client becomes the
    // default and wins over the system client.
    const res = await app.request("/api/integrations/@myorg/gmail/auths/google/connect/oauth2", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth_url: string };
    // Uses the ORG client_id, NOT the system one.
    expect(body.auth_url).toContain("client_id=org-client");
    expect(body.auth_url).not.toContain("sys-client");
  });
});
