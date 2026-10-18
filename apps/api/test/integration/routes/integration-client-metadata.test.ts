// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth Client ID Metadata Documents for integration connections (#2076, MCP 2026-07-28 client
 * registration): an auto-provisioned auth (remote MCP, `token_endpoint_auth_method: none`) whose
 * authorization server advertises `client_id_metadata_document_supported` (and RFC 9207 `iss`)
 * connects with this instance's document OF THAT SERVER as `client_id` — nothing registered,
 * nothing stored, the server's own tagged redirect URI — when `APP_URL` is public https and
 * `INTEGRATION_OAUTH_CIMD` is not `off`; it falls back to DCR otherwise.
 *
 * A loopback server plays the MCP server and its authorization-server metadata (RFC 9728 → RFC
 * 8414, + RFC 7591 registration it counts). Its authorize endpoint fronts a CONFORMANT server
 * (`strict-authorization-server.ts`) and adds `iss`; the token endpoint is the conformant one's,
 * registered with the document URL as its public client, so the exchange and the refresh are
 * protocol-checked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
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
import { oauthStateStore } from "../../../src/services/connect/oauth-state-store.ts";
import { authorizationServerTag } from "../../../src/lib/integration-callback-url.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";

const app = getTestApp();
const INTEGRATION = "@myorg/remote-mcp";
const AUTH_KEY = "oauth";
const PUBLIC_APP_URL = "https://appstrate.example.com";
const CALLBACK = `${PUBLIC_APP_URL}/api/integrations/callback`;

const documentUrl = (issuer: string, appUrl = PUBLIC_APP_URL) =>
  `${appUrl}/oauth/client-metadata/${Buffer.from(issuer).toString("base64url")}.json`;
const documentName = (issuer: string) => `${Buffer.from(issuer).toString("base64url")}.json`;

interface Advertise {
  cimd: boolean;
  registration: boolean;
  /** RFC 9207: advertise `authorization_response_iss_parameter_supported` and send `iss`. */
  iss?: boolean;
}

/** The remote MCP server and its authorization server's metadata, fronting `provider`. */
interface MetadataServer {
  base: string;
  registrations: number;
  /** Set once the conformant server exists (its client id is this server's document URL). */
  provider: StrictAuthorizationServer | null;
  stop: () => void;
}

function startMetadataServer(advertise: Advertise): MetadataServer {
  const handle: MetadataServer = { base: "", registrations: 0, provider: null, stop: () => {} };
  const iss = advertise.iss ?? true;
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
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: handle.provider!.tokenEndpoint,
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          ...(iss ? { authorization_response_iss_parameter_supported: true } : {}),
          ...(advertise.registration ? { registration_endpoint: `${base}/register` } : {}),
          ...(advertise.cimd ? { client_id_metadata_document_supported: true } : {}),
        });
      }
      if (url.pathname === "/authorize") {
        // The conformant server decides; this one only stamps its `iss` on the way back.
        const upstream = await fetch(`${handle.provider!.authorizationEndpoint}${url.search}`, {
          redirect: "manual",
        });
        const location = upstream.headers.get("Location");
        if (!location) return upstream;
        const back = new URL(location);
        if (iss) back.searchParams.set("iss", base);
        return new Response(null, { status: 302, headers: { Location: back.toString() } });
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

function setEnv(name: "APP_URL" | "INTEGRATION_OAUTH_CIMD", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  resetEnvCache();
}

let previous: { appUrl?: string; cimd?: string };
let restoreEgress: () => void;

beforeAll(() => {
  previous = { appUrl: process.env.APP_URL, cimd: process.env.INTEGRATION_OAUTH_CIMD };
  restoreEgress = allowLoopbackOAuthEgress();
});

afterAll(() => {
  restoreEgress();
  setEnv("INTEGRATION_OAUTH_CIMD", previous.cimd);
  setEnv("APP_URL", previous.appUrl);
});

describe("GET /oauth/client-metadata/{document} (public)", () => {
  beforeEach(() => setEnv("APP_URL", PUBLIC_APP_URL));

  it("serves the document of the server its name encodes, naming that server's redirect URI", async () => {
    const issuer = "https://mcp.notion.com";
    const res = await app.request(`/oauth/client-metadata/${documentName(issuer)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({
      client_id: documentUrl(issuer),
      client_name: "Appstrate (appstrate.example.com)",
      client_uri: PUBLIC_APP_URL,
      redirect_uris: [`${CALLBACK}/cimd/${authorizationServerTag(issuer)}`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("serves no shared document", async () => {
    expect((await app.request("/oauth/client-metadata.json")).status).toBe(404);
  });

  it("serves an http issuer only on a host the operator allowlisted", async () => {
    // `localhost` is allowlisted for this file (`allowLoopbackOAuthEgress`).
    expect(
      (await app.request(`/oauth/client-metadata/${documentName("http://localhost:9999")}`)).status,
    ).toBe(200);
    expect(
      (await app.request(`/oauth/client-metadata/${documentName("http://idp.example.com")}`))
        .status,
    ).toBe(404);
  });

  it("404s a name encoding no admissible issuer, a non-canonical one, or an overlong one", async () => {
    const overlong = documentName(`https://idp.example.com/${"a".repeat(1600)}`);
    expect(overlong.length).toBeGreaterThan(2048);
    expect(
      (await app.request(`/oauth/client-metadata/${documentName("https://idp.example.com/ok")}`))
        .status,
    ).toBe(200);
    // "aHR0cHM6Ly9hLmJ" decodes like "aHR0cHM6Ly9hLmI" (base64url("https://a.b")): non-canonical.
    for (const name of [
      documentName("not a url"),
      documentName("ftp://idp.example.com"),
      "aHR0cHM6Ly9hLmJ.json",
      "x.txt",
      overlong,
    ]) {
      expect((await app.request(`/oauth/client-metadata/${name}`)).status).toBe(404);
    }
  });
});

describe("auto-provisioned client: CIMD first, DCR as fallback", () => {
  let ctx: TestContext;
  let meta: MetadataServer;

  /** Install the remote integration on a fresh metadata server, its provider bound to `clientId`. */
  async function install(
    advertise: Advertise,
    opts: { method?: "none" | "client_secret_post"; clientSecret?: string; clientId?: string } = {},
  ): Promise<void> {
    meta = startMetadataServer(advertise);
    meta.provider = createStrictAuthorizationServer({
      clientId: opts.clientId ?? documentUrl(meta.base),
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      ...(opts.clientSecret ? {} : { acceptedAuthMethods: ["none"] as const }),
      expiresIn: 60,
    });
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
            tokenEndpointAuthMethod: opts.method ?? "none",
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
    const picked = resolved.provisioningFailure
      ? null
      : resolveConnectClient(
          INTEGRATION,
          AUTH_KEY,
          manifest as IntegrationManifest,
          auth as AfpsManifestAuth,
          resolved,
        );
    return { resolved, picked };
  }

  /** POST …/connect/oauth2 → the authorize URL and its `state`. */
  async function begin(): Promise<URL> {
    const res = await app.request(
      `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/connect/oauth2`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    return new URL(((await res.json()) as { auth_url: string }).auth_url);
  }

  /** The browser's consent hop: the URL the authorization server sends it back to. */
  async function consent(authUrl: URL): Promise<URL> {
    const res = await fetch(authUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("Location")!);
  }

  const callbackText = async (url: URL | string) =>
    (await app.request(typeof url === "string" ? url : url.pathname + url.search)).text();

  beforeEach(async () => {
    setEnv("APP_URL", PUBLIC_APP_URL);
    setEnv("INTEGRATION_OAUTH_CIMD", undefined);
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  afterEach(() => {
    meta?.provider?.stop();
    meta?.stop();
  });

  it("connects and refreshes with the server's document as client_id, storing no client", async () => {
    await install({ cimd: true, registration: true });
    const document = documentUrl(meta.base);
    const tag = authorizationServerTag(meta.base);

    const authUrl = await begin();
    expect(authUrl.searchParams.get("client_id")).toBe(document);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${CALLBACK}/cimd/${tag}`);
    // The state requires `iss`, as decided from the metadata the client was chosen on.
    const stateRecord = await oauthStateStore.get(authUrl.searchParams.get("state")!);
    expect(stateRecord!.integration).toMatchObject({
      issuer: meta.base,
      issParameterSupported: true,
      redirectTag: `cimd/${tag}`,
    });
    // The document the server would fetch lists exactly that redirect URI.
    const served = await app.request(new URL(document).pathname);
    expect(await served.json()).toMatchObject({
      client_id: document,
      redirect_uris: [`${CALLBACK}/cimd/${tag}`],
    });

    const back = await consent(authUrl);
    expect(back.pathname).toBe(`/api/integrations/callback/cimd/${tag}`);
    expect(await callbackText(back)).not.toContain("error");

    expect(meta.registrations).toBe(0);
    expect(await db.select().from(integrationOauthClients)).toEqual([]);
    const [connection] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(connection!.clientRef).toBe(document);
    const provider = meta.provider!;
    const exchange = provider.tokenRequests[0]!;
    expect(exchange).toMatchObject({ grantType: "authorization_code", status: 200 });
    expect(exchange.params.client_id).toBe(document);
    expect(exchange.params.client_secret).toBeUndefined();
    expect(exchange.authorization).toBeUndefined();

    // The manifest declares no issuer: refresh finds the token endpoint from the issuer the
    // document's name binds.
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
    expect(provider.tokenRequests[1]!.params.client_id).toBe(document);
  });

  it("refuses a response from another server: at the shared callback, without iss, or with its iss", async () => {
    await install({ cimd: true, registration: true });
    const refused = "did not come from the authorization server";

    // Server B returning the code to the shared callback (no tag).
    const first = await consent(await begin());
    expect(await callbackText(`/api/integrations/callback${first.search}`)).toContain(refused);
    // B returning it to A's tag, without `iss` (A advertised it) or with its own.
    const second = await consent(await begin());
    second.searchParams.delete("iss");
    expect(await callbackText(second)).toContain(refused);
    const third = await consent(await begin());
    third.searchParams.set("iss", "https://honest-b.example.com");
    expect(await callbackText(third)).toContain(refused);

    expect(meta.provider!.tokenRequests).toHaveLength(0);
    expect(await db.select().from(integrationConnections)).toEqual([]);
  });

  it("never completes a DCR flow with a response on a document's redirect URI", async () => {
    // A DCR client of a server without `iss` (fixed server: no tag). A response arriving on the
    // document namespace — where a server handed our document would send it — is refused.
    await install({ cimd: false, registration: true, iss: false }, { clientId: "dcr-1" });
    const back = await consent(await begin());
    expect(back.pathname).toBe("/api/integrations/callback");
    const onDocumentPath = `/api/integrations/callback/cimd/${authorizationServerTag(meta.base)}${back.search}`;
    expect(await callbackText(onDocumentPath)).toContain(
      "did not come from the authorization server",
    );
    expect(meta.provider!.tokenRequests).toHaveLength(0);
    expect(await db.select().from(integrationConnections)).toEqual([]);
  });

  it("refuses a document client bound to another server than the state's (issuer_mismatch)", async () => {
    await install({ cimd: true, registration: true });
    const back = await consent(await begin());
    const state = back.searchParams.get("state")!;
    const record = (await oauthStateStore.get(state))!;
    await oauthStateStore.set(
      state,
      {
        ...record,
        integration: { ...record.integration!, clientRef: documentUrl("https://other.example") },
      },
      600,
    );
    expect(await callbackText(back)).toContain("did not come from the authorization server");
    expect(meta.provider!.tokenRequests).toHaveLength(0);
    expect(await db.select().from(integrationConnections)).toEqual([]);
  });

  it("registers by DCR when the server does not advertise RFC 9207 iss", async () => {
    await install({ cimd: true, registration: true, iss: false });
    const { resolved, picked } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    expect(picked!.clientId).toBe("dcr-1");
    expect(meta.registrations).toBe(1);
  });

  it("takes the document over a machine client DCR registered before", async () => {
    await install({ cimd: true, registration: true });
    setEnv("INTEGRATION_OAUTH_CIMD", "off");
    const before = await connectClient();
    expect(meta.registrations).toBe(1);

    setEnv("INTEGRATION_OAUTH_CIMD", "on");
    const { picked } = await connectClient();
    expect(picked).toEqual({
      clientId: documentUrl(meta.base),
      redirectUri: `${CALLBACK}/cimd/${authorizationServerTag(meta.base)}`,
      redirectTag: `cimd/${authorizationServerTag(meta.base)}`,
      clientRef: documentUrl(meta.base),
    });
    // The registered client stays, for the connections that pinned it.
    expect(
      await resolveIntegrationClientById(
        before.picked!.clientRef,
        ctx.defaultSpaceId,
        INTEGRATION,
        AUTH_KEY,
        "none",
      ),
    ).toMatchObject({ clientId: "dcr-1" });
    expect(meta.registrations).toBe(1);
  });

  it("INTEGRATION_OAUTH_CIMD: on (and empty) presents the document, off registers by DCR", async () => {
    await install({ cimd: true, registration: true });
    for (const value of ["on", ""]) {
      setEnv("INTEGRATION_OAUTH_CIMD", value);
      expect((await connectClient()).picked!.clientRef).toBe(documentUrl(meta.base));
    }
    expect(meta.registrations).toBe(0);
    setEnv("INTEGRATION_OAUTH_CIMD", "off");
    const { resolved, picked } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    expect(picked!.clientId).toBe("dcr-1");
    expect(meta.registrations).toBe(1);
  });

  it("registers by DCR when the server does not advertise CIMD", async () => {
    await install({ cimd: false, registration: true });
    const { resolved, picked } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    const rows = await db.select().from(integrationOauthClients);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: "dcr-1", autoProvisioned: true });
    expect(picked!.clientRef).toBe(rows[0]!.id);
  });

  it("registers by DCR on an instance no server can fetch a document from, even if advertised", async () => {
    await install({ cimd: true, registration: true });
    for (const appUrl of ["http://localhost:3000", "https://localhost:3000", "https://10.0.0.5"]) {
      setEnv("APP_URL", appUrl);
      const { resolved } = await connectClient();
      expect(resolved.metadataDocumentClient).toBeUndefined();
      expect(resolved.orgClients).toHaveLength(1);
    }
    expect(meta.registrations).toBe(1);
  });

  it("says why when the server accepts only documents and the instance presents none", async () => {
    await install({ cimd: true, registration: false });
    setEnv("APP_URL", "http://localhost:3000");
    const { resolved } = await connectClient();
    expect(resolved.provisioningFailure?.message).toContain("public https APP_URL");
    expect(resolved.provisioningFailure?.message).toContain("INTEGRATION_OAUTH_CIMD");
    expect(await db.select().from(integrationOauthClients)).toEqual([]);
  });

  // The platform's per-server callbacks: a metadata document's, and a per-connection DCR client's.
  const RESERVED = {
    document: `${CALLBACK}/cimd/${authorizationServerTag("https://honest-b.example.com")}`,
    "per-server DCR": `${CALLBACK}/${authorizationServerTag("https://honest-x.example.com")}`,
  };

  it.each(Object.entries(RESERVED))(
    "refuses an administrator's client redirect_uri on a %s callback",
    async (_kind, reserved) => {
      await install(
        { cimd: true, registration: true },
        { method: "client_secret_post", clientId: "admin-app", clientSecret: "shh" },
      );
      const send = (method: string, path: string, headers: Record<string, string>, body: unknown) =>
        app.request(path, {
          method,
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const body = { client_id: "admin-app", client_secret: "shh", redirect_uri: reserved };
      for (const [path, headers] of [
        [`/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/oauth-clients`, authHeaders(ctx)],
        [
          `/api/org-integrations/${INTEGRATION}/auths/${AUTH_KEY}/oauth-clients`,
          orgOnlyHeaders(ctx),
        ],
      ] as const) {
        const res = await send("POST", path, headers, body);
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("redirect_uri_reserved");
      }
      expect(await db.select().from(integrationOauthClients)).toEqual([]);

      // Update: a client registered without the URI cannot be moved into the namespace either.
      const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
      const admin = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "admin-app",
        clientSecret: "shh",
      });
      const patched = await send(
        "PATCH",
        `/api/integrations/${INTEGRATION}/oauth-clients/${admin.id}`,
        authHeaders(ctx),
        { redirect_uri: reserved },
      );
      expect(patched.status).toBe(400);
      expect(((await patched.json()) as { code: string }).code).toBe("redirect_uri_reserved");
      // The shared callback stays registrable.
      const shared = await send(
        "PATCH",
        `/api/integrations/${INTEGRATION}/oauth-clients/${admin.id}`,
        authHeaders(ctx),
        { redirect_uri: CALLBACK },
      );
      expect(shared.status).toBe(200);
    },
  );

  it.each(Object.entries(RESERVED))(
    "refuses to connect through a stored client on a %s callback (rows written before)",
    async (_kind, reserved) => {
      // The insider scenario: an admin client on the callback of an honest server (a CIMD server B,
      // a per-connection DCR server X without iss) would put that server's tag in a state requiring
      // nothing of it. Written straight to the table, as before the write guard existed; connect
      // refuses it before any redirect.
      await install(
        { cimd: true, registration: true },
        { method: "client_secret_post", clientId: "admin-app", clientSecret: "shh" },
      );
      const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
      const admin = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
        clientId: "admin-app",
        clientSecret: "shh",
      });
      await db
        .update(integrationOauthClients)
        .set({ redirectUri: reserved })
        .where(eq(integrationOauthClients.id, admin.id));
      const res = await app.request(
        `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/connect/oauth2`,
        {
          method: "POST",
          headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { detail: string }).detail).toContain(
        "reserved for the platform's per-server callbacks",
      );
      expect(meta.provider!.authorizeRequests).toHaveLength(0);
    },
  );

  it("never takes a leftover per-server DCR row as a classic flow's client", async () => {
    // A version that chose its server per connection left the org a DCR row for server X (its
    // redirect URI X's tag); the current version is classic (fixed server). That row must be
    // neither connected through, nor listed, nor made default: its tag would ride with this
    // flow's token endpoint.
    await install(
      { cimd: true, registration: true },
      { method: "client_secret_post", clientId: "admin-app", clientSecret: "shh" },
    );
    const [leftover] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId: null,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId: "dcr-x",
        clientSecretEncrypted: "",
        tokenEndpointAuthMethod: "none",
        isDefault: true,
        autoProvisioned: true,
        issuer: "https://honest-x.example.com",
        redirectUri: `${CALLBACK}/${authorizationServerTag("https://honest-x.example.com")}`,
      })
      .returning({ id: integrationOauthClients.id });

    const begin = await app.request(
      `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/connect/oauth2`,
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(begin.status).toBe(403);
    expect(meta.provider!.authorizeRequests).toHaveLength(0);

    const listed = await app.request(`/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/clients`, {
      headers: authHeaders(ctx),
    });
    expect(JSON.stringify(await listed.json())).not.toContain(leftover!.id);
    const setDefault = await app.request(
      `/api/integrations/${INTEGRATION}/auths/${AUTH_KEY}/default-client`,
      {
        method: "PUT",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ client_ref: leftover!.id }),
      },
    );
    expect(setDefault.status).toBe(400);
  });

  it("binds a per-server DCR row's redirect URI to the flow's own server", async () => {
    // Reached directly (the tiers no longer hand such a row to a classic flow): a tagged row on a
    // classic auth, or on a per-connection auth whose flow resolved another server, is refused.
    const tagX = authorizationServerTag("https://honest-x.example.com");
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      spaceId: null,
      integration_package_id: INTEGRATION,
      auth_key: AUTH_KEY,
      client_id: "dcr-x",
      clientSecret: "",
      has_client_secret: false,
      token_endpoint_auth_method: "none",
      redirect_uri: `${CALLBACK}/${tagX}`,
      isDefault: true,
      autoProvisioned: true,
      issuer: "https://honest-x.example.com",
      secretKeyUnavailable: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const auths = (issuer: string) =>
      ({ type: "oauth2", issuer, token_endpoint_auth_method: "none" }) as AfpsManifestAuth;
    const manifestOf = (auth: AfpsManifestAuth) =>
      ({
        type: "integration",
        name: INTEGRATION,
        source: { kind: "none" },
        auths: { [AUTH_KEY]: auth },
      }) as unknown as IntegrationManifest;
    const pick = (auth: AfpsManifestAuth, flowIssuer: string) =>
      resolveConnectClient(INTEGRATION, AUTH_KEY, manifestOf(auth), auth, {
        spaceClients: [],
        orgClients: [row],
        authorizationServer: { issuer: flowIssuer, issParameterSupported: false },
      } as Parameters<typeof resolveConnectClient>[4]);

    const fixed = auths("https://fixed-h.example.com");
    expect(() => pick(fixed, "https://fixed-h.example.com")).toThrow(
      expect.objectContaining({ code: "oauth_client_redirect_mismatch", status: 403 }),
    );
    const perConnection = auths("{$variable.base_url}");
    expect(() => pick(perConnection, "https://other-y.example.com")).toThrow(
      expect.objectContaining({ code: "oauth_client_redirect_mismatch" }),
    );
    expect(pick(perConnection, "https://honest-x.example.com")).toMatchObject({
      clientId: "dcr-x",
      redirectTag: tagX,
    });
  });

  it("keeps an administrator's client on an auth that is not auto-provisioned", async () => {
    await install(
      { cimd: true, registration: true },
      { method: "client_secret_post", clientId: "admin-app", clientSecret: "shh" },
    );
    const scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const admin = await createIntegrationOAuthClient(scope, INTEGRATION, AUTH_KEY, {
      clientId: "admin-app",
      clientSecret: "shh",
    });
    const { resolved, picked } = await connectClient();
    expect(resolved.metadataDocumentClient).toBeUndefined();
    expect(picked!.clientRef).toBe(admin.id);
    expect(meta.registrations).toBe(0);
  });
});

describe("a metadata-document client_ref resolves without a row", () => {
  beforeEach(() => setEnv("APP_URL", PUBLIC_APP_URL));

  it("binds the document to the server its name encodes", async () => {
    const issuer = "https://gitlab.example.org";
    expect(
      await resolveIntegrationClientById(
        documentUrl(issuer),
        "spc_unused",
        INTEGRATION,
        AUTH_KEY,
        undefined,
      ),
    ).toEqual({
      clientId: documentUrl(issuer),
      clientSecret: "",
      tokenEndpointAuthMethod: "none",
      issuer,
    });
  });

  it("resolves no document of another origin (an APP_URL the instance moved away from)", async () => {
    expect(
      await resolveIntegrationClientById(
        documentUrl("https://gitlab.example.org", "https://old.example.com"),
        "spc_unused",
        INTEGRATION,
        AUTH_KEY,
        undefined,
      ),
    ).toBeNull();
  });
});
