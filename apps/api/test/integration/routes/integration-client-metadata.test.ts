// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Client ID Metadata Documents for integration connections (#2076, MCP 2026-07-28 client
 * registration): an auto-provisioned auth (remote MCP, `token_endpoint_auth_method: none`) whose
 * authorization server advertises `client_id_metadata_document_supported` connects with this
 * instance's document URL as `client_id` — nothing registered, nothing stored — when `APP_URL` is
 * public https; it falls back to DCR otherwise.
 *
 * A loopback server plays the MCP server and its authorization-server metadata (RFC 9728 → RFC
 * 8414, + RFC 7591 registration it counts); the authorize and token endpoints it advertises are a
 * CONFORMANT server's (`strict-authorization-server.ts`), registered with the document URL as its
 * public client, so the exchange and the refresh are protocol-checked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import {
  createStrictAuthorizationServer,
  allowLoopbackOAuthEgress,
  type StrictAuthorizationServer,
} from "../../helpers/strict-authorization-server.ts";
import {
  integrationConnections,
  integrationOauthClients,
  spacePackages,
} from "@appstrate/db/schema";
import { refreshConnectionCredential } from "../../../src/services/integration-token-refresh.ts";
import {
  createIntegrationOAuthClient,
  ensureIntegrationOAuthClient,
  readCredentialRevision,
  readIntegrationAuth,
  resolveConnectClient,
  resolveIntegrationClientById,
} from "../../../src/services/integration-connections.ts";
import { authorizationServerTag } from "../../../src/lib/integration-callback-url.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();
const INTEGRATION = "@myorg/remote-mcp";
const AUTH_KEY = "oauth";
const PUBLIC_APP_URL = "https://appstrate.example.com";
const DOCUMENT_URL = `${PUBLIC_APP_URL}/oauth/client-metadata.json`;
const CALLBACK = `${PUBLIC_APP_URL}/api/integrations/callback`;

/** The remote MCP server and its authorization server's metadata, pointing at `provider`. */
interface MetadataServer {
  base: string;
  registrations: number;
  stop: () => void;
}

function startMetadataServer(
  provider: StrictAuthorizationServer,
  advertise: { cimd: boolean; registration: boolean },
): MetadataServer {
  const handle: MetadataServer = { base: "", registrations: 0, stop: () => {} };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const base = `${url.protocol}//${url.host}`;
      if (url.pathname === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: base,
          authorization_endpoint: provider.authorizationEndpoint,
          token_endpoint: provider.tokenEndpoint,
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          ...(advertise.registration ? { registration_endpoint: `${base}/register` } : {}),
          ...(advertise.cimd ? { client_id_metadata_document_supported: true } : {}),
        });
      }
      if (req.method === "POST" && url.pathname === "/register") {
        const body = (await req.json()) as { redirect_uris: string[] };
        handle.registrations++;
        return json(
          {
            client_id: `dcr-${handle.registrations}`,
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

function setAppUrl(value: string): void {
  process.env.APP_URL = value;
  resetEnvCache();
}

let previousAppUrl: string | undefined;
let restoreEgress: () => void;

beforeAll(() => {
  previousAppUrl = process.env.APP_URL;
  restoreEgress = allowLoopbackOAuthEgress();
});

afterAll(() => {
  restoreEgress();
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
  resetEnvCache();
});

describe("GET /oauth/client-metadata.json (public)", () => {
  beforeEach(() => setAppUrl(PUBLIC_APP_URL));

  it("serves the document whose client_id is its own URL", async () => {
    const res = await app.request("/oauth/client-metadata.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({
      client_id: DOCUMENT_URL,
      client_name: "Appstrate (appstrate.example.com)",
      client_uri: PUBLIC_APP_URL,
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("serves a per-server document naming that server's own redirect URI", async () => {
    const issuer = "https://gitlab.example.org";
    const name = `${Buffer.from(issuer).toString("base64url")}.json`;
    const res = await app.request(`/oauth/client-metadata/${name}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(`${PUBLIC_APP_URL}/oauth/client-metadata/${name}`);
    expect(body.redirect_uris).toEqual([`${CALLBACK}/${authorizationServerTag(issuer)}`]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("404s a name encoding no issuer URL, or not in its canonical encoding", async () => {
    const notUrl = `${Buffer.from("not a url").toString("base64url")}.json`;
    // "aHR0cHM6Ly9hLmI" is base64url("https://a.b"); a trailing extra bit spells it twice.
    for (const name of [notUrl, "aHR0cHM6Ly9hLmJ.json", "x.txt", "%2E%2E.json"]) {
      const res = await app.request(`/oauth/client-metadata/${name}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("auto-provisioned client: CIMD first, DCR as fallback", () => {
  let ctx: TestContext;
  let provider: StrictAuthorizationServer;
  let meta: MetadataServer;

  async function install(advertise: { cimd: boolean; registration: boolean }): Promise<void> {
    provider = createStrictAuthorizationServer({
      clientId: DOCUMENT_URL,
      acceptedAuthMethods: ["none"],
      expiresIn: 60,
    });
    meta = startMetadataServer(provider, advertise);
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remoteIntegrationManifest({
        name: INTEGRATION,
        url: `${meta.base}/mcp`,
        auths: {
          [AUTH_KEY]: {
            type: "oauth2",
            // Declared so refresh finds the token endpoint (the connection pins no issuer).
            issuer: meta.base,
            tokenEndpointAuthMethod: "none",
            defaultScopes: ["read"],
            codeChallengeMethodsSupported: ["S256"],
          },
        },
      }),
    });
    await db
      .insert(spacePackages)
      .values({ enabled: true, spaceId: ctx.defaultSpaceId, packageId: INTEGRATION });
  }

  /** The client a connect from the default space takes — the calls `OAuth2Strategy.begin` makes. */
  async function connectClient() {
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const { manifest, auth } = await readIntegrationAuth(scope, INTEGRATION, AUTH_KEY);
    const resolved = await ensureIntegrationOAuthClient(
      scope,
      INTEGRATION,
      AUTH_KEY,
      manifest as IntegrationManifest,
      auth as AfpsManifestAuth,
      `${process.env.APP_URL}/api/integrations/callback`,
    );
    return { resolved, manifest, auth };
  }

  beforeEach(async () => {
    setAppUrl(PUBLIC_APP_URL);
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  afterEach(() => {
    meta?.stop();
    provider?.stop();
  });

  it("connects and refreshes with the document URL as client_id, storing no client", async () => {
    await install({ cimd: true, registration: true });

    const begin = await app.request(
      `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/connect/oauth2`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(begin.status).toBe(200);
    const authUrl = new URL(((await begin.json()) as { auth_url: string }).auth_url);
    expect(authUrl.searchParams.get("client_id")).toBe(DOCUMENT_URL);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(CALLBACK);

    // The browser's consent hop, then the platform's public callback.
    const consent = await fetch(authUrl, { redirect: "manual" });
    expect(consent.status).toBe(302);
    const location = new URL(consent.headers.get("Location")!);
    const callback = await app.request(
      `/api/integrations/callback?code=${encodeURIComponent(location.searchParams.get("code")!)}&state=${encodeURIComponent(location.searchParams.get("state")!)}`,
    );
    expect(callback.status).toBe(200);

    expect(meta.registrations).toBe(0);
    expect(await db.select().from(integrationOauthClients)).toEqual([]);
    const [connection] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(connection!.clientRef).toBe(DOCUMENT_URL);
    const exchange = provider.tokenRequests[0]!;
    expect(exchange).toMatchObject({ grantType: "authorization_code", status: 200 });
    expect(exchange.params.client_id).toBe(DOCUMENT_URL);
    expect(exchange.params.client_secret).toBeUndefined();
    expect(exchange.authorization).toBeUndefined();

    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const { auth } = await readIntegrationAuth(scope, INTEGRATION, AUTH_KEY);
    const outcome = await refreshConnectionCredential({
      connection: {
        ...connection!,
        credentialRevision: (await readCredentialRevision(connection!.id))!,
      },
      integrationId: INTEGRATION,
      authDef: auth as AfpsManifestAuth,
      scope,
      actor: { type: "user", id: ctx.user.id },
      trigger: { kind: "rejected", revision: null },
    });
    expect(outcome.status).toBe("refreshed");
    expect(provider.tokenRequests[1]).toMatchObject({ grantType: "refresh_token", status: 200 });
    expect(provider.tokenRequests[1]!.params.client_id).toBe(DOCUMENT_URL);
  });

  it("takes the document over a machine client DCR registered before", async () => {
    await install({ cimd: true, registration: true });
    setAppUrl("http://localhost:3000");
    const before = await connectClient();
    const dcrRef = resolveConnectClient(
      INTEGRATION,
      AUTH_KEY,
      before.manifest as IntegrationManifest,
      before.auth as AfpsManifestAuth,
      before.resolved,
    ).clientRef;
    expect(meta.registrations).toBe(1);

    setAppUrl(PUBLIC_APP_URL);
    const { resolved, manifest, auth } = await connectClient();
    const picked = resolveConnectClient(
      INTEGRATION,
      AUTH_KEY,
      manifest as IntegrationManifest,
      auth as AfpsManifestAuth,
      resolved,
    );
    expect(picked).toEqual({
      clientId: DOCUMENT_URL,
      redirectUri: CALLBACK,
      clientRef: DOCUMENT_URL,
    });
    // The registered client stays, for the connections that pinned it.
    expect(
      await resolveIntegrationClientById(dcrRef, ctx.defaultSpaceId, INTEGRATION, AUTH_KEY, "none"),
    ).toMatchObject({ clientId: "dcr-1" });
    expect(meta.registrations).toBe(1);
  });

  it("registers by DCR when the server does not advertise CIMD", async () => {
    await install({ cimd: false, registration: true });
    const { resolved, manifest, auth } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    const picked = resolveConnectClient(
      INTEGRATION,
      AUTH_KEY,
      manifest as IntegrationManifest,
      auth as AfpsManifestAuth,
      resolved,
    );
    const rows = await db.select().from(integrationOauthClients);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: "dcr-1", autoProvisioned: true });
    expect(picked.clientRef).toBe(rows[0]!.id);
    expect(meta.registrations).toBe(1);
  });

  it("registers by DCR on an instance no server can fetch a document from, even if advertised", async () => {
    await install({ cimd: true, registration: true });
    for (const appUrl of ["http://localhost:3000", "https://localhost:3000", "https://10.0.0.5"]) {
      setAppUrl(appUrl);
      const { resolved } = await connectClient();
      expect(resolved.metadataDocumentClient).toBeUndefined();
      expect(resolved.orgClients).toHaveLength(1);
    }
    expect(meta.registrations).toBe(1);
  });

  it("says why when the server accepts only documents and the instance cannot serve one", async () => {
    await install({ cimd: true, registration: false });
    setAppUrl("http://localhost:3000");
    const { resolved } = await connectClient();
    expect(resolved.provisioningFailure?.message).toContain("public https APP_URL");
    expect(await db.select().from(integrationOauthClients)).toEqual([]);
  });

  it("keeps an administrator's client on an auth that is not auto-provisioned", async () => {
    provider = createStrictAuthorizationServer({ clientId: "admin-app", clientSecret: "shh" });
    meta = startMetadataServer(provider, { cimd: true, registration: true });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      type: "integration",
      source: "local",
      draftManifest: remoteIntegrationManifest({
        name: INTEGRATION,
        url: `${meta.base}/mcp`,
        auths: {
          [AUTH_KEY]: {
            type: "oauth2",
            issuer: meta.base,
            tokenEndpointAuthMethod: "client_secret_post",
            defaultScopes: ["read"],
          },
        },
      }),
    });
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const admin = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
      clientId: "admin-app",
      clientSecret: "shh",
    });
    const { resolved, manifest, auth } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    expect(
      resolveConnectClient(
        INTEGRATION,
        AUTH_KEY,
        manifest as IntegrationManifest,
        auth as AfpsManifestAuth,
        resolved,
      ).clientRef,
    ).toBe(admin.id);
    expect(meta.registrations).toBe(0);
  });
});

describe("a metadata-document client_ref resolves without a row", () => {
  beforeEach(() => setAppUrl(PUBLIC_APP_URL));

  it("binds a per-server document to the server its name encodes", async () => {
    const issuer = "https://gitlab.example.org";
    const ref = `${PUBLIC_APP_URL}/oauth/client-metadata/${Buffer.from(issuer).toString("base64url")}.json`;
    expect(
      await resolveIntegrationClientById(ref, "spc_unused", INTEGRATION, AUTH_KEY, undefined),
    ).toEqual({ clientId: ref, clientSecret: "", tokenEndpointAuthMethod: "none", issuer });
    expect(
      await resolveIntegrationClientById(
        DOCUMENT_URL,
        "spc_unused",
        INTEGRATION,
        AUTH_KEY,
        undefined,
      ),
    ).toEqual({ clientId: DOCUMENT_URL, clientSecret: "", tokenEndpointAuthMethod: "none" });
  });

  it("resolves no document of another origin (an APP_URL the instance moved away from)", async () => {
    expect(
      await resolveIntegrationClientById(
        "https://old.example.com/oauth/client-metadata.json",
        "spc_unused",
        INTEGRATION,
        AUTH_KEY,
        undefined,
      ),
    ).toBeNull();
  });
});
