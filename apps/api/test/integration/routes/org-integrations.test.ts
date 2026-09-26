// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP surface of org-level integration OAuth clients (#1264):
 * `/api/org-integrations/*` and the space-tier promote route. The resolution
 * cascade itself is covered by `test/integration/services/integration-org-clients.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  authHeaders,
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpace } from "../../helpers/seed.ts";
import { auditEvents, integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { __resetSystemIntegrationsForTest } from "../../../src/services/integration-client-registry.ts";

const app = getTestApp();

const delivery = {
  http: { in: "header", name: "Authorization", prefix: "Bearer ", value: "{$credential.x}" },
};

function oauthManifest(name: string): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "0.1.0",
    display_name: "Gmail",
    description: "Gmail integration",
    source: { kind: "local", server: { name, version: "^0.1.0" } },
    auths: {
      google: {
        type: "oauth2",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        default_scopes: ["openid", "email"],
        authorized_uris: ["https://www.googleapis.com/**"],
        delivery,
      },
    },
  } as unknown as IntegrationManifest;
}

/** Remote MCP auth whose client is auto-provisioned (DCR/CIMD) — space-only. */
function remoteMcpManifest(name: string): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.1",
    name,
    version: "1.0.0",
    display_name: "Remote MCP",
    description: "Remote MCP integration",
    source: {
      kind: "remote",
      remote: { url: "https://mcp.invalid/mcp", transport: "streamable-http" },
    },
    auths: {
      oauth: {
        type: "oauth2",
        issuer: "https://mcp.invalid",
        token_endpoint_auth_method: "none",
        default_scopes: ["read"],
        authorized_uris: ["https://mcp.invalid/**"],
        delivery,
      },
    },
  } as unknown as IntegrationManifest;
}

async function seedIntegration(orgId: string, manifest: IntegrationManifest) {
  await seedPackage({
    id: manifest.name,
    orgId,
    type: "integration",
    source: "local",
    draftManifest: manifest,
  });
}

interface Descriptor {
  client_ref: string;
  source: string;
  client_id: string;
  is_default: boolean;
}

const ORG_BASE = "/api/org-integrations/@myorg/gmail";
const SPACE_BASE = "/api/integrations/@myorg/gmail";

describe("/api/org-integrations — org-level OAuth clients", () => {
  let ctx: TestContext;
  let json: Record<string, string>;
  let spaceJson: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    __resetSystemIntegrationsForTest();
    ctx = await createTestContext({ orgSlug: "myorg" });
    json = orgOnlyHeaders(ctx, { "Content-Type": "application/json" });
    spaceJson = authHeaders(ctx, { "Content-Type": "application/json" });
    await seedIntegration(ctx.orgId, oauthManifest("@myorg/gmail"));
  });

  afterEach(() => __resetSystemIntegrationsForTest());

  async function createOrgClient(clientId: string): Promise<string> {
    const res = await app.request(`${ORG_BASE}/auths/google/oauth-clients`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ client_id: clientId, client_secret: "s3cret" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; spaceId: string | null };
    expect(body.spaceId).toBeNull();
    return body.id;
  }

  async function createSpaceClient(clientId: string): Promise<string> {
    const res = await app.request(`${SPACE_BASE}/auths/google/oauth-clients`, {
      method: "POST",
      headers: spaceJson,
      body: JSON.stringify({ client_id: clientId, client_secret: "s3cret" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function list(url: string, headers: Record<string, string>): Promise<Descriptor[]> {
    const res = await app.request(url, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Descriptor[] }).data;
  }

  const listOrg = () => list(`${ORG_BASE}/auths/google/clients`, orgOnlyHeaders(ctx));
  const listSpace = () => list(`${SPACE_BASE}/auths/google/clients`, authHeaders(ctx));
  const promote = (clientId: string, headers: Record<string, string> = authHeaders(ctx)) =>
    app.request(`${SPACE_BASE}/oauth-clients/${clientId}/promote`, { method: "POST", headers });

  it("registers, lists, sets the default, rotates and deletes org clients", async () => {
    const a = await createOrgClient("org-a");
    const b = await createOrgClient("org-b");
    expect(await listOrg()).toEqual([
      expect.objectContaining({
        client_ref: a,
        source: "org",
        client_id: "org-a",
        is_default: true,
      }),
      expect.objectContaining({
        client_ref: b,
        source: "org",
        client_id: "org-b",
        is_default: false,
      }),
    ]);

    const setDefault = await app.request(`${ORG_BASE}/auths/google/default-client`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ client_ref: b }),
    });
    expect(setDefault.status).toBe(200);
    const relisted = ((await setDefault.json()) as { data: Descriptor[] }).data;
    expect(relisted.filter((c) => c.is_default).map((c) => c.client_ref)).toEqual([b]);

    const rotated = await app.request(`${ORG_BASE}/oauth-clients/${a}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ client_id: "org-a-2" }),
    });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { client_id: string }).client_id).toBe("org-a-2");

    const deleted = await app.request(`${ORG_BASE}/oauth-clients/${a}`, {
      method: "DELETE",
      headers: orgOnlyHeaders(ctx),
    });
    expect(deleted.status).toBe(204);
    expect((await listOrg()).map((c) => c.client_ref)).toEqual([b]);

    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, ctx.orgId),
          eq(auditEvents.action, "integration.oauth_client.deleted"),
        ),
      );
    expect(audit?.spaceId).toBeNull();
    expect(audit?.after).toMatchObject({ deletedConnections: 0 });
  });

  it("keeps the tiers apart on the by-id routes (404 both ways)", async () => {
    const orgClient = await createOrgClient("org-app");
    const spaceClient = await createSpaceClient("space-app");

    const viaOrg = await app.request(`${ORG_BASE}/oauth-clients/${spaceClient}`, {
      method: "DELETE",
      headers: orgOnlyHeaders(ctx),
    });
    expect(viaOrg.status).toBe(404);

    const viaSpace = await app.request(`${SPACE_BASE}/oauth-clients/${orgClient}`, {
      method: "PUT",
      headers: spaceJson,
      body: JSON.stringify({ client_id: "hijack" }),
    });
    expect(viaSpace.status).toBe(404);

    expect(await db.select().from(integrationOauthClients)).toHaveLength(2);
  });

  it("404s an integration of another org and a non-UUID client id", async () => {
    const other = await createTestContext({ orgSlug: "other" });
    await seedIntegration(other.orgId, oauthManifest("@other/gmail"));

    const res = await app.request("/api/org-integrations/@other/gmail/auths/google/clients", {
      headers: orgOnlyHeaders(ctx),
    });
    expect(res.status).toBe(404);

    const created = await app.request(
      "/api/org-integrations/@other/gmail/auths/google/oauth-clients",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({ client_id: "x", client_secret: "y" }),
      },
    );
    expect(created.status).toBe(404);

    const badId = await app.request(`${ORG_BASE}/oauth-clients/not-a-uuid`, {
      method: "DELETE",
      headers: orgOnlyHeaders(ctx),
    });
    expect(badId.status).toBe(404);
  });

  it("refuses an org client on an auto-provisioned (DCR/CIMD) auth (400)", async () => {
    await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
    const res = await app.request(
      "/api/org-integrations/@myorg/remote-mcp/auths/oauth/oauth-clients",
      {
        method: "POST",
        headers: json,
        body: JSON.stringify({ client_id: "x", client_secret: "y" }),
      },
    );
    expect(res.status).toBe(400);
    expect(await db.select().from(integrationOauthClients)).toHaveLength(0);
  });

  it("forbids a member session (403)", async () => {
    const member = await memberContext(ctx, "member");
    const headers = orgOnlyHeaders(member);

    const listed = await app.request(`${ORG_BASE}/auths/google/clients`, { headers });
    expect(listed.status).toBe(403);
    const created = await app.request(`${ORG_BASE}/auths/google/oauth-clients`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "x", client_secret: "y" }),
    });
    expect(created.status).toBe(403);
    expect(await db.select().from(integrationOauthClients)).toHaveLength(0);
  });

  it("forbids an owner-minted API key (session-only permission, 403)", async () => {
    const orgClient = await createOrgClient("org-app");
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["integrations:read"],
    });
    const asKey = { Authorization: `Bearer ${key.rawKey}`, "Content-Type": "application/json" };

    const listed = await app.request(`${ORG_BASE}/auths/google/clients`, { headers: asKey });
    expect(listed.status).toBe(403);
    const created = await app.request(`${ORG_BASE}/auths/google/oauth-clients`, {
      method: "POST",
      headers: asKey,
      body: JSON.stringify({ client_id: "x", client_secret: "y" }),
    });
    expect(created.status).toBe(403);
    const deleted = await app.request(`${ORG_BASE}/oauth-clients/${orgClient}`, {
      method: "DELETE",
      headers: asKey,
    });
    expect(deleted.status).toBe(403);
    expect(await db.select().from(integrationOauthClients)).toHaveLength(1);
  });

  it("a space with no client of its own lists and connects with the org client", async () => {
    const orgClient = await createOrgClient("org-app");

    expect(await listSpace()).toEqual([
      expect.objectContaining({ client_ref: orgClient, source: "org", is_default: true }),
    ]);

    const res = await app.request(`${SPACE_BASE}/auths/google/connect/oauth2`, {
      method: "POST",
      headers: spaceJson,
      body: "{}",
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { auth_url: string }).auth_url);
    expect(url.searchParams.get("client_id")).toBe("org-app");
  });

  describe("POST /api/integrations/{packageId}/oauth-clients/{clientId}/promote", () => {
    it("moves a space client to the org; its connections stay listed", async () => {
      const client = await createSpaceClient("space-app");
      await db.insert(integrationConnections).values({
        integrationId: "@myorg/gmail",
        authKey: "google",
        accountId: "a@x.test",
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        credentialsEncrypted: "enc",
        clientRef: client,
      });

      const res = await promote(client);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: client, spaceId: null, client_id: "space-app" });

      const [row] = await db
        .select()
        .from(integrationOauthClients)
        .where(eq(integrationOauthClients.id, client));
      expect(row).toMatchObject({ spaceId: null, isDefault: true });
      expect(await listSpace()).toEqual([
        expect.objectContaining({ client_ref: client, source: "org", is_default: true }),
      ]);

      const conns = await app.request(`${SPACE_BASE}/connections`, { headers: authHeaders(ctx) });
      expect(conns.status).toBe(200);
      expect(((await conns.json()) as { data: { client_ref: string }[] }).data).toEqual([
        expect.objectContaining({ client_ref: client, needs_reconnection: false }),
      ]);

      const [audit] = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "integration.oauth_client.promoted"));
      expect(audit?.resourceId).toBe(`@myorg/gmail#google#${client}`);
    });

    it("403s a space admin who lacks org-integrations:configure", async () => {
      const client = await createSpaceClient("space-app");
      const spaceAdmin = await memberContext(ctx, "member", "admin");

      expect((await promote(client, authHeaders(spaceAdmin))).status).toBe(403);
      const [row] = await db
        .select()
        .from(integrationOauthClients)
        .where(eq(integrationOauthClients.id, client));
      expect(row?.spaceId).toBe(ctx.defaultSpaceId);
    });

    it("404s a client of another space, an org client and a non-UUID id", async () => {
      const second = await seedSpace({ orgId: ctx.orgId, name: "Second" });
      const [foreign] = await db
        .insert(integrationOauthClients)
        .values({
          orgId: ctx.orgId,
          spaceId: second.id,
          integrationId: "@myorg/gmail",
          authKey: "google",
          clientId: "second-app",
          clientSecretEncrypted: "enc",
        })
        .returning({ id: integrationOauthClients.id });
      const orgClient = await createOrgClient("org-app");

      expect((await promote(foreign!.id)).status).toBe(404);
      expect((await promote(orgClient)).status).toBe(404);
      expect((await promote("not-a-uuid")).status).toBe(404);
    });

    it("400s an auto-provisioned (DCR/CIMD) client", async () => {
      await seedIntegration(ctx.orgId, remoteMcpManifest("@myorg/remote-mcp"));
      const [auto] = await db
        .insert(integrationOauthClients)
        .values({
          orgId: ctx.orgId,
          spaceId: ctx.defaultSpaceId,
          integrationId: "@myorg/remote-mcp",
          authKey: "oauth",
          clientId: "dcr-client",
          clientSecretEncrypted: "",
          tokenEndpointAuthMethod: "none",
          autoProvisioned: true,
        })
        .returning({ id: integrationOauthClients.id });

      const res = await app.request(
        `/api/integrations/@myorg/remote-mcp/oauth-clients/${auto!.id}/promote`,
        { method: "POST", headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(400);
    });
  });
});
