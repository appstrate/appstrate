// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-provisioned (DCR) OAuth clients live at the ORG tier (#1870): the first connect from any
 * space registers one client per (org, integration, auth, authorization server), every other space
 * reuses it, and the connections it mints serve the whole org. Space-tier clients registered before
 * keep refreshing the connections they minted until a reconnect moves those onto the org client.
 *
 * A loopback server plays the remote MCP server and its authorization server
 * (RFC 9728 → RFC 8414 → RFC 7591) and counts the registrations it receives.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import {
  ensureIntegrationOAuthClient,
  persistCredentialBundle,
  promoteIntegrationOAuthClient,
  resolveConnectClient,
  resolveIntegrationClientById,
} from "../../../src/services/integration-connections.ts";
import { usableInSpace } from "../../../src/services/connection-reach.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

const REMOTE = "@myorg/remote-mcp";
const AUTH_KEY = "oauth";
const REDIRECT = "https://app.example.com/api/integrations/callback";

interface AuthServer {
  base: string;
  registrations: number;
  stop: () => void;
}

function startAuthServer(): AuthServer {
  const handle: AuthServer = { base: "", registrations: 0, stop: () => {} };
  let n = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const base = `${url.protocol}//${url.host}`;
      if (req.method === "GET" && url.pathname === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (req.method === "POST" && url.pathname === "/oauth/register") {
        const body = (await req.json()) as { redirect_uris: string[] };
        handle.registrations++;
        return json(
          {
            client_id: `dcr-${++n}`,
            token_endpoint_auth_method: "none",
            redirect_uris: body.redirect_uris,
          },
          201,
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  handle.base = `http://localhost:${server.port}`;
  handle.stop = () => server.stop(true);
  return handle;
}

describe("auto-provisioned OAuth clients at the org tier", () => {
  let as: AuthServer;
  let manifest: IntegrationManifest;
  let auth: AfpsManifestAuth;
  let ctx: TestContext;
  let actor: Actor;
  let spaceA: SpaceScope;
  let spaceB: SpaceScope;

  beforeAll(() => {
    as = startAuthServer();
    auth = {
      type: "oauth2",
      token_endpoint_auth_method: "none",
      default_scopes: ["read"],
      authorized_uris: [`${as.base}/**`],
      delivery: { http: { in: "header", name: "Authorization", value: "{$credential.token}" } },
    } as unknown as AfpsManifestAuth;
    manifest = {
      type: "integration",
      schema_version: "0.1",
      name: REMOTE,
      version: "1.0.0",
      display_name: "Remote MCP",
      source: {
        kind: "remote",
        remote: { url: `${as.base}/mcp`, transport: "streamable-http" },
      },
      auths: { [AUTH_KEY]: auth },
    } as unknown as IntegrationManifest;
  });
  afterAll(() => as.stop());

  beforeEach(async () => {
    await truncateAll();
    as.registrations = 0;
    ctx = await createTestContext({ orgSlug: "myorg" });
    actor = { type: "user", id: ctx.user.id };
    spaceA = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const b = await seedSpace({ orgId: ctx.orgId, name: "B" });
    spaceB = { orgId: ctx.orgId, spaceId: b.id };
    await seedPackage({
      id: REMOTE,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: manifest,
    });
  });

  /** The client a connect flow from `scope` uses — the calls `OAuth2Strategy.begin` makes. */
  async function connectClientRef(scope: SpaceScope): Promise<string> {
    const resolved = await ensureIntegrationOAuthClient(
      scope,
      REMOTE,
      AUTH_KEY,
      manifest,
      auth,
      REDIRECT,
    );
    return resolveConnectClient(REMOTE, AUTH_KEY, manifest, auth, resolved).clientRef;
  }

  /** A completed connect from `scope`: the callback's insert. Returns the connection id. */
  async function connect(scope: SpaceScope, accountId: string): Promise<string> {
    const clientRef = await connectClientRef(scope);
    const conn = await persistCredentialBundle(
      { kind: "insert", scope, actor },
      { credentials: { token: "at" }, packageId: REMOTE, authKey: AUTH_KEY, accountId, clientRef },
    );
    return conn!.id;
  }

  async function seedLegacySpaceClient(spaceId: string, clientId = "legacy"): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId,
        integrationId: REMOTE,
        authKey: AUTH_KEY,
        clientId,
        clientSecretEncrypted: "",
        tokenEndpointAuthMethod: "none",
        isDefault: true,
        autoProvisioned: true,
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  async function usableIds(spaceId: string): Promise<string[]> {
    const rows = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(usableInSpace(spaceId, actor));
    return rows.map((r) => r.id).sort();
  }

  it("registers one org client in A that B reuses; both connections serve the org", async () => {
    const fromA = await connect(spaceA, "alice@a");
    const fromB = await connect(spaceB, "alice@b");
    expect(as.registrations).toBe(1);

    const clients = await db.select().from(integrationOauthClients);
    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({ spaceId: null, autoProvisioned: true, isDefault: true });

    const conns = await db.select().from(integrationConnections);
    expect(conns.find((c) => c.id === fromA)).toMatchObject({
      spaceId: null,
      originSpaceId: spaceA.spaceId,
      clientRef: clients[0]!.id,
    });
    expect(conns.find((c) => c.id === fromB)).toMatchObject({
      spaceId: null,
      originSpaceId: spaceB.spaceId,
      clientRef: clients[0]!.id,
    });
    for (const scope of [spaceA, spaceB]) {
      expect(await usableIds(scope.spaceId)).toEqual([fromA, fromB].sort());
      expect(
        await resolveIntegrationClientById(clients[0]!.id, scope.spaceId, REMOTE, AUTH_KEY, "none"),
      ).toEqual({
        clientId: clients[0]!.clientId,
        clientSecret: "",
        tokenEndpointAuthMethod: "none",
      });
    }
  });

  it("concurrent connects from two spaces leave one client row", async () => {
    const refs = await Promise.all([connectClientRef(spaceA), connectClientRef(spaceB)]);
    const clients = await db.select().from(integrationOauthClients);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.spaceId).toBeNull();
    expect(refs).toEqual([clients[0]!.id, clients[0]!.id]);
  });

  it("a legacy space client keeps refreshing its connection; a reconnect widens it onto the org client", async () => {
    const legacy = await seedLegacySpaceClient(spaceA.spaceId);
    const [old] = await db
      .insert(integrationConnections)
      .values({
        integrationId: REMOTE,
        authKey: AUTH_KEY,
        accountId: "alice@a",
        label: "alice@a",
        orgId: ctx.orgId,
        spaceId: spaceA.spaceId,
        userId: ctx.user.id,
        credentialsEncrypted: "enc",
        clientRef: legacy,
      })
      .returning({ id: integrationConnections.id });

    expect(
      await resolveIntegrationClientById(legacy, spaceA.spaceId, REMOTE, AUTH_KEY, "none"),
    ).toEqual({ clientId: "legacy", clientSecret: "", tokenEndpointAuthMethod: "none" });
    expect(await usableIds(spaceB.spaceId)).toEqual([]);

    const clientRef = await connectClientRef(spaceA);
    expect(as.registrations).toBe(1);
    expect(clientRef).not.toBe(legacy);
    await persistCredentialBundle(
      {
        kind: "update-owned",
        scope: spaceA,
        actor,
        connectionId: old!.id,
        packageId: REMOTE,
        authKey: AUTH_KEY,
      },
      { credentials: { token: "at-2" }, accountId: "alice@a", clientRef },
    );

    const [row] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, old!.id));
    expect(row).toMatchObject({ spaceId: null, originSpaceId: spaceA.spaceId, clientRef });
    expect(await usableIds(spaceB.spaceId)).toEqual([old!.id]);
  });

  it("a space client, legacy or manual, excludes no org row from its space", async () => {
    const conn = await connect(spaceA, "alice@a");
    await seedLegacySpaceClient(spaceB.spaceId);
    expect(await usableIds(spaceB.spaceId)).toEqual([conn]);

    await db
      .update(integrationOauthClients)
      .set({ isDefault: false })
      .where(eq(integrationOauthClients.spaceId, spaceB.spaceId));
    await db.insert(integrationOauthClients).values({
      orgId: ctx.orgId,
      spaceId: spaceB.spaceId,
      integrationId: REMOTE,
      authKey: AUTH_KEY,
      clientId: "manual",
      clientSecretEncrypted: "",
      tokenEndpointAuthMethod: "none",
      isDefault: true,
    });
    expect(await usableIds(spaceB.spaceId)).toEqual([conn]);
    expect(await usableIds(spaceA.spaceId)).toEqual([conn]);
  });

  it("promotes a legacy space client to the org, which every space then reuses", async () => {
    const legacy = await seedLegacySpaceClient(spaceB.spaceId);
    expect(await promoteIntegrationOAuthClient(spaceB, REMOTE, legacy)).toMatchObject({
      id: legacy,
      spaceId: null,
      autoProvisioned: true,
    });
    expect(await connectClientRef(spaceA)).toBe(legacy);
    expect(as.registrations).toBe(0);
  });

  it("refuses to promote a legacy space client once the org holds its own (409)", async () => {
    const legacy = await seedLegacySpaceClient(spaceB.spaceId);
    await connect(spaceA, "alice@a");
    await expect(promoteIntegrationOAuthClient(spaceB, REMOTE, legacy)).rejects.toMatchObject({
      status: 409,
      code: "auto_client_exists_at_org",
    });
    const [row] = await db
      .select({ spaceId: integrationOauthClients.spaceId })
      .from(integrationOauthClients)
      .where(eq(integrationOauthClients.id, legacy));
    expect(row!.spaceId).toBe(spaceB.spaceId);
  });
});
