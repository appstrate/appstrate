// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/org-integrations/*` — org-level integration OAuth clients (#1264):
 * inherited by every space of the org, overridden by a space's own client.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedPackage, seedSpace } from "../../helpers/seed.ts";
import { auditEvents, integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";

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
  default_selectable: boolean;
}

const ORG_BASE = "/api/org-integrations/@myorg/gmail";
const SPACE_BASE = "/api/integrations/@myorg/gmail";

describe("/api/org-integrations — org-level OAuth clients", () => {
  let ctx: TestContext;
  let json: Record<string, string>;

  beforeEach(async () => {
    await truncateAll();
    __resetSystemIntegrationsForTest();
    ctx = await createTestContext({ orgSlug: "myorg" });
    json = orgOnlyHeaders(ctx, { "Content-Type": "application/json" });
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
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
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

  it("registers, lists, rotates and deletes an org client", async () => {
    const id = await createOrgClient("org-app");

    expect(await listOrg()).toEqual([
      expect.objectContaining({
        client_ref: id,
        source: "org",
        client_id: "org-app",
        is_default: true,
        default_selectable: true,
      }),
    ]);

    const rotated = await app.request(`${ORG_BASE}/oauth-clients/${id}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ client_id: "org-app-2" }),
    });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { client_id: string }).client_id).toBe("org-app-2");

    const deleted = await app.request(`${ORG_BASE}/oauth-clients/${id}`, {
      method: "DELETE",
      headers: orgOnlyHeaders(ctx),
    });
    expect(deleted.status).toBe(204);
    expect(await listOrg()).toEqual([]);
  });

  it("sets the org default among org clients, then falls back to the system client", async () => {
    initSystemIntegrations([
      {
        id: "@myorg/gmail",
        clients: [
          { id: "gmail-system", auth_key: "google", client_id: "sys", client_secret: "sys-s" },
        ],
      },
    ]);
    await createOrgClient("a");
    const b = await createOrgClient("b");
    const setDefault = (ref: string) =>
      app.request(`${ORG_BASE}/auths/google/default-client`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ client_ref: ref }),
      });

    const res = await setDefault(b);
    expect(res.status).toBe(200);
    const clients = ((await res.json()) as { data: Descriptor[] }).data;
    expect(clients.filter((c) => c.is_default).map((c) => c.client_ref)).toEqual([b]);
    expect(clients.every((c) => c.default_selectable)).toBe(true);

    expect((await setDefault("gmail-system")).status).toBe(200);
    expect((await listOrg()).find((c) => c.is_default)?.client_ref).toBe("gmail-system");
    const flagged = await db
      .select({ id: integrationOauthClients.id })
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.isDefault, true));
    expect(flagged).toHaveLength(0);
  });

  it("refuses a space client as the org default (400)", async () => {
    await createOrgClient("org-app");
    const spaceClient = await createSpaceClient("space-app");
    const res = await app.request(`${ORG_BASE}/auths/google/default-client`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ client_ref: spaceClient }),
    });
    expect(res.status).toBe(400);
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
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "hijack" }),
    });
    expect(viaSpace.status).toBe(404);

    const rows = await db.select().from(integrationOauthClients);
    expect(rows).toHaveLength(2);
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
    const member = await createTestUser({ email: "member@myorg.test" });
    await addOrgMember(ctx.orgId, member.id, "member");
    const headers = { Cookie: member.cookie, "X-Org-Id": ctx.orgId };

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

  it("deleting an org client deletes its connections in every space of the org", async () => {
    const orgClient = await createOrgClient("org-app");
    const spaceClient = await createSpaceClient("space-app");
    const second = await seedSpace({ orgId: ctx.orgId, name: "Second" });
    const conn = (spaceId: string, accountId: string, clientRef: string) => ({
      integrationId: "@myorg/gmail",
      authKey: "google",
      accountId,
      spaceId,
      userId: ctx.user.id,
      credentialsEncrypted: "enc",
      clientRef,
    });
    await db
      .insert(integrationConnections)
      .values([
        conn(ctx.defaultSpaceId, "a@x.test", orgClient),
        conn(second.id, "b@x.test", orgClient),
        conn(ctx.defaultSpaceId, "c@x.test", spaceClient),
      ]);

    const res = await app.request(`${ORG_BASE}/oauth-clients/${orgClient}`, {
      method: "DELETE",
      headers: orgOnlyHeaders(ctx),
    });
    expect(res.status).toBe(204);

    const left = await db.select().from(integrationConnections);
    expect(left.map((c) => c.clientRef)).toEqual([spaceClient]);

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
    expect(audit?.after).toMatchObject({ deletedConnections: 2 });
  });

  it("a space with no client of its own inherits the org client, and connect uses it", async () => {
    const orgClient = await createOrgClient("org-app");

    expect(await listSpace()).toEqual([
      expect.objectContaining({
        client_ref: orgClient,
        source: "org",
        is_default: true,
        default_selectable: true,
      }),
    ]);

    const res = await app.request(`${SPACE_BASE}/auths/google/connect/oauth2`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { auth_url: string }).auth_url);
    expect(url.searchParams.get("client_id")).toBe("org-app");
  });

  it("a space client overrides the org client; the org client stays selectable as inherited default", async () => {
    const orgClient = await createOrgClient("org-app");
    const spaceClient = await createSpaceClient("space-app");

    const clients = await listSpace();
    expect(clients.find((c) => c.is_default)?.client_ref).toBe(spaceClient);
    expect(clients.find((c) => c.client_ref === orgClient)).toMatchObject({
      source: "org",
      is_default: false,
      default_selectable: true,
    });

    const res = await app.request(`${SPACE_BASE}/auths/google/default-client`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_ref: orgClient }),
    });
    expect(res.status).toBe(200);
    const after = ((await res.json()) as { data: Descriptor[] }).data;
    expect(after.find((c) => c.is_default)?.client_ref).toBe(orgClient);
  });
});
