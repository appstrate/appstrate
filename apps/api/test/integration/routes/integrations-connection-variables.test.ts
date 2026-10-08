// SPDX-License-Identifier: Apache-2.0
/**
 * Connection variables (AFPS §7.12) and authorization servers chosen per connection (§7.3).
 *
 * A loopback "forge" plays a self-hosted MCP server and its authorization server: RFC 9728
 * protected-resource metadata behind a `WWW-Authenticate` challenge, RFC 8414 metadata, RFC 7591
 * registration, an authorize endpoint that redirects back with `iss` (RFC 9207), and a token
 * endpoint. It answers for whichever host it is reached by, so `localhost` and `127.0.0.1` are two
 * distinct authorization servers. Both hosts are in the test preload's egress allowlist.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { buildIntegrationOAuthRefreshContext } from "../../../src/services/integration-token-refresh.ts";
import { authorizationServerTag } from "../../../src/lib/integration-callback-url.ts";
import type { AfpsManifestAuth } from "../../../src/services/integration-manifest-helpers.ts";

const app = getTestApp();

interface Forge {
  port: number;
  registrations: Array<{ host: string; redirectUris: string[] }>;
  tokenRequests: Array<Record<string, string>>;
  /** Overrides the advertised authorization servers, by resource path prefix. */
  advertise: Map<string, string[]>;
  stop: () => void;
}

function startForge(): Forge {
  const registrations: Forge["registrations"] = [];
  const tokenRequests: Forge["tokenRequests"] = [];
  const advertise = new Map<string, string[]>();
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
      const prm = "/.well-known/oauth-protected-resource";
      if (
        req.method === "GET" &&
        url.pathname.endsWith("/api/v4/mcp") &&
        !url.pathname.startsWith(prm)
      ) {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${base}${prm}${url.pathname}"`,
          },
        });
      }
      if (req.method === "GET" && url.pathname.startsWith(`${prm}/`)) {
        const path = url.pathname.slice(prm.length);
        const prefix = path.replace(/\/api\/v4\/mcp$/, "");
        return json({
          resource: `${base}${path}`,
          authorization_servers: advertise.get(prefix) ?? [`${base}${prefix}`],
        });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (req.method === "POST" && url.pathname === "/oauth/register") {
        const body = (await req.json()) as { redirect_uris: string[] };
        registrations.push({ host: url.host, redirectUris: body.redirect_uris });
        return json(
          {
            client_id: `dcr-${url.hostname}-${++n}`,
            token_endpoint_auth_method: "none",
            redirect_uris: body.redirect_uris,
          },
          201,
        );
      }
      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", `code-${++n}`);
        back.searchParams.set("state", url.searchParams.get("state")!);
        back.searchParams.set("iss", base);
        return new Response(null, { status: 302, headers: { Location: back.toString() } });
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const params = Object.fromEntries(new URLSearchParams(await req.text()).entries());
        tokenRequests.push(params);
        return json({
          access_token: `at-${++n}`,
          refresh_token: `rt-${n}`,
          expires_in: 3600,
          token_type: "Bearer",
          scope: "mcp",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port!,
    registrations,
    tokenRequests,
    advertise,
    stop: () => server.stop(true),
  };
}

const variablesSchema = {
  schema: {
    type: "object",
    properties: { base_url: { type: "string", format: "uri", pattern: "^https?://" } },
    required: ["base_url"],
  },
};

function forgeManifest(name: string, withIssuer = true): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.3",
    name,
    version: "1.0.0",
    display_name: "Forge",
    description: "Self-hosted forge",
    source: {
      kind: "remote",
      remote: { url: "{$variable.base_url}/api/v4/mcp", transport: "streamable-http" },
    },
    variables: variablesSchema,
    auths: {
      oauth: {
        type: "oauth2",
        ...(withIssuer ? { issuer: "{$variable.base_url}" } : {}),
        token_endpoint_auth_method: "none",
        code_challenge_methods_supported: ["S256"],
        default_scopes: ["mcp"],
        authorized_uris: ["{$variable.base_url}/api/v4/**"],
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
}

function tokenManifest(name: string): IntegrationManifest {
  return {
    type: "integration",
    schema_version: "0.3",
    name,
    version: "1.0.0",
    display_name: "Panel",
    description: "Self-hosted panel",
    source: {
      kind: "remote",
      remote: { url: "{$variable.base_url}/mcp", transport: "streamable-http" },
    },
    variables: variablesSchema,
    auths: {
      token: {
        type: "api_key",
        authorized_uris: ["{$variable.base_url}/**"],
        credentials: {
          schema: {
            type: "object",
            properties: { api_key: { type: "string" } },
            required: ["api_key"],
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

function readSetCookie(res: Response): string {
  const m = (res.headers.get("set-cookie") ?? "").match(/appstrate_connect=([^;]+)/);
  expect(m).not.toBeNull();
  return `appstrate_connect=${m![1]}`;
}

/** Open a hosted session for `packageId`/`authKey` and return its cookie + CSRF + context. */
async function openHosted(ctx: TestContext, packageId: string, authKey: string, body = {}) {
  const minted = await app.request(
    `/api/integrations/${packageId}/auths/${authKey}/connect/session`,
    {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(minted.status).toBe(200);
  const { connect_url } = (await minted.json()) as { connect_url: string };
  const start = await app.request(new URL(connect_url).pathname + new URL(connect_url).search, {
    redirect: "manual",
  });
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toBe("/connect");
  const cookie = readSetCookie(start);
  const contextRes = await app.request("/api/integrations/connect/context", {
    headers: { Cookie: cookie },
  });
  expect(contextRes.status).toBe(200);
  const context = (await contextRes.json()) as {
    csrf: string;
    variables: { schema: unknown; values: Record<string, string> } | null;
  };
  return { cookie, context };
}

async function submitHosted(
  session: { cookie: string; context: { csrf: string } },
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/integrations/connect/submit", {
    method: "POST",
    headers: {
      Cookie: session.cookie,
      "x-connect-csrf": session.context.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Drive the provider's authorize redirect and return the platform callback path + query. */
async function authorize(redirectUrl: string): Promise<URL> {
  const res = await fetch(redirectUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!);
}

describe("connection variables — credential connections", () => {
  let ctx: TestContext;
  let forge: Forge;
  let base: string;
  beforeAll(() => {
    forge = startForge();
    base = `http://localhost:${forge.port}`;
  });
  afterAll(() => forge.stop());
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, tokenManifest("@myorg/panel"));
  });

  async function importConnection(body: Record<string, unknown>): Promise<Response> {
    return app.request("/api/integrations/@myorg/panel/auths/token/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("persists the variables with the credential and returns them", async () => {
    const res = await importConnection({
      credentials: { api_key: "k1" },
      variables: { base_url: base },
    });
    expect(res.status).toBe(200);
    const conn = (await res.json()) as { id: string; variables: Record<string, string> | null };
    expect(conn.variables).toEqual({ base_url: base });
    const [row] = await db
      .select({ variables: integrationConnections.variables })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, conn.id));
    expect(row!.variables).toEqual({ base_url: base });

    const list = await app.request("/api/integrations/@myorg/panel/connections", {
      headers: authHeaders(ctx),
    });
    const { data } = (await list.json()) as { data: Array<{ variables: unknown }> };
    expect(data[0]!.variables).toEqual({ base_url: base });
  });

  it("replaces the variables on reconnect, in the credential's write", async () => {
    const first = (await (
      await importConnection({ credentials: { api_key: "k1" }, variables: { base_url: base } })
    ).json()) as { id: string };
    const other = `http://127.0.0.1:${forge.port}`;
    const res = await importConnection({
      credentials: { api_key: "k2" },
      variables: { base_url: other },
      connection_id: first.id,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { variables: unknown }).variables).toEqual({ base_url: other });
  });

  it("refuses missing, undeclared, unrenderable and egress-blocked variables", async () => {
    const cases: Array<[Record<string, unknown> | undefined, string, string]> = [
      [undefined, "variables.base_url", "invalid_variable"],
      [{ base_url: base, extra: "x" }, "variables.extra", "unknown_variable"],
      [{ base_url: `${base}/?q=1` }, "variables.base_url", "unrenderable_variable"],
      [{ base_url: "https://169.254.169.254" }, "variables.base_url", "egress_blocked"],
    ];
    for (const [variables, field, code] of cases) {
      const res = await importConnection({
        credentials: { api_key: "k" },
        ...(variables ? { variables } : {}),
      });
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        errors: Array<{ field: string; code: string }>;
      };
      expect(problem.code).toBe("validation_failed");
      expect(problem.errors).toContainEqual(expect.objectContaining({ field, code }));
    }
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
  });

  it("refuses variables for an integration that declares none", async () => {
    const plain = tokenManifest("@myorg/plain") as unknown as Record<string, unknown>;
    delete plain.variables;
    (plain.source as { remote: { url: string } }).remote.url = "https://mcp.example.com/mcp";
    (plain.auths as { token: { authorized_uris: string[] } }).token.authorized_uris = [
      "https://mcp.example.com/**",
    ];
    await seedIntegration(ctx.orgId, plain as unknown as IntegrationManifest);
    const res = await app.request("/api/integrations/@myorg/plain/auths/token/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "k" }, variables: { base_url: base } }),
    });
    expect(res.status).toBe(400);
    const ok = await app.request("/api/integrations/@myorg/plain/auths/token/connect/fields", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { api_key: "k" } }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { variables: unknown }).variables).toBeNull();
  });

  it("hosted form: returns the reconnected connection's values in the context", async () => {
    const conn = (await (
      await importConnection({ credentials: { api_key: "k1" }, variables: { base_url: base } })
    ).json()) as { id: string };
    const session = await openHosted(ctx, "@myorg/panel", "token", { connection_id: conn.id });
    expect(session.context.variables!.values).toEqual({ base_url: base });
    const res = await submitHosted(session, {
      credentials: { api_key: "k2" },
      variables: { base_url: base },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { connection: { variables: unknown } }).connection.variables,
    ).toEqual({ base_url: base });
  });
});

describe("authorization server chosen per connection (AFPS §7.3)", () => {
  let ctx: TestContext;
  let forge: Forge;
  let base: string;
  let otherBase: string;
  beforeAll(() => {
    forge = startForge();
    base = `http://localhost:${forge.port}`;
    otherBase = `http://127.0.0.1:${forge.port}`;
  });
  afterAll(() => forge.stop());
  beforeEach(async () => {
    await truncateAll();
    forge.registrations.length = 0;
    forge.tokenRequests.length = 0;
    forge.advertise.clear();
    ctx = await createTestContext({ orgSlug: "myorg" });
    await seedIntegration(ctx.orgId, forgeManifest("@myorg/forge"));
  });

  async function beginHosted(baseUrl: string) {
    const session = await openHosted(ctx, "@myorg/forge", "oauth");
    expect(session.context.variables).toEqual({ schema: variablesSchema.schema, values: {} });
    return { session, res: await submitHosted(session, { variables: { base_url: baseUrl } }) };
  }

  it("hosted form: begins OAuth with a per-server client, then persists the variables at the tagged callback", async () => {
    const { res } = await beginHosted(base);
    expect(res.status).toBe(200);
    const { ok, redirect_url } = (await res.json()) as { ok: boolean; redirect_url: string };
    expect(ok).toBe(true);
    const authorizeUrl = new URL(redirect_url);
    expect(authorizeUrl.origin).toBe(base);
    const tag = authorizationServerTag(base);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toEndWith(
      `/api/integrations/callback/${tag}`,
    );
    // RFC 8707: the protected resource's identifier.
    expect(authorizeUrl.searchParams.get("resource")).toBe(`${base}/api/v4/mcp`);
    expect(forge.registrations).toHaveLength(1);
    expect(forge.registrations[0]!.redirectUris[0]).toEndWith(`/callback/${tag}`);

    const [client] = await db.select().from(integrationOauthClients);
    expect(client!.issuer).toBe(base);
    expect(client!.autoProvisioned).toBe(true);

    const callback = await authorize(redirect_url);
    expect(callback.pathname).toBe(`/api/integrations/callback/${tag}`);
    const done = await app.request(callback.pathname + callback.search);
    expect(done.status).toBe(200);
    expect(await done.text()).not.toContain("error");
    const [conn] = await db.select().from(integrationConnections);
    expect(conn!.variables).toEqual({ base_url: base });
    expect(conn!.clientRef).toBe(client!.id);
    expect(forge.tokenRequests[0]!.resource).toBe(`${base}/api/v4/mcp`);
    // AFPS §8.6: the refresh is a token request too, bound to the same resource.
    expect(conn!.oauthResource).toBe(`${base}/api/v4/mcp`);
    const auth = (forgeManifest("@myorg/forge").auths as Record<string, unknown>)
      .oauth as AfpsManifestAuth;
    const refresh = await buildIntegrationOAuthRefreshContext(
      "@myorg/forge",
      "oauth",
      auth,
      ctx.defaultSpaceId,
      conn!,
    );
    expect(refresh!.resource).toBe(`${base}/api/v4/mcp`);
  });

  it("keys auto-provisioned clients by issuer: two servers, two clients, two redirect URIs", async () => {
    expect((await beginHosted(base)).res.status).toBe(200);
    expect((await beginHosted(otherBase)).res.status).toBe(200);
    expect((await beginHosted(base)).res.status).toBe(200);
    const clients = await db.select().from(integrationOauthClients);
    expect(clients.map((c) => c.issuer).sort()).toEqual([base, otherBase].sort());
    expect(new Set(clients.map((c) => c.redirectUri)).size).toBe(2);
    expect(forge.registrations).toHaveLength(2);
  });

  it("refuses a response arriving at the shared callback, or carrying another iss", async () => {
    const { res } = await beginHosted(base);
    const { redirect_url } = (await res.json()) as { redirect_url: string };
    const callback = await authorize(redirect_url);
    const plain = await app.request(`/api/integrations/callback${callback.search}`);
    expect(await plain.text()).toContain("did not come from the authorization server");
    // The refusal burned the state: the genuine response no longer completes either.
    await app.request(callback.pathname + callback.search);
    expect(await db.select().from(integrationConnections)).toHaveLength(0);

    const second = await beginHosted(base);
    const cb2 = await authorize(
      ((await second.res.json()) as { redirect_url: string }).redirect_url,
    );
    cb2.searchParams.set("iss", "https://gitlab.com");
    const forged = await app.request(cb2.pathname + cb2.search);
    expect(await forged.text()).toContain("did not come from the authorization server");
    expect(await db.select().from(integrationConnections)).toHaveLength(0);
    expect(forge.tokenRequests).toHaveLength(0);
  });

  it("refuses a server whose metadata names another provider's authorization server", async () => {
    forge.advertise.set("/evil", ["https://gitlab.com"]);
    const { res } = await beginHosted(`${base}/evil`);
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { errors: Array<{ field: string; code: string }> };
    expect(problem.errors).toContainEqual(
      expect.objectContaining({
        field: "variables.base_url",
        code: "authorization_server_mismatch",
      }),
    );
    expect(forge.registrations).toHaveLength(0);
    expect(await db.select().from(integrationOauthClients)).toHaveLength(0);
  });

  it("without a declared issuer, takes the first advertised server on the URL's origin", async () => {
    await seedIntegration(ctx.orgId, forgeManifest("@myorg/forge-any", false));
    forge.advertise.set("", ["https://gitlab.com", base]);
    const minted = await app.request(
      "/api/integrations/@myorg/forge-any/auths/oauth/connect/oauth2",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ variables: { base_url: base } }),
      },
    );
    expect(minted.status).toBe(200);
    expect(new URL(((await minted.json()) as { auth_url: string }).auth_url).origin).toBe(base);

    forge.advertise.set("", ["https://gitlab.com"]);
    const refused = await app.request(
      "/api/integrations/@myorg/forge-any/auths/oauth/connect/oauth2",
      {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ variables: { base_url: otherBase } }),
      },
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("authorization_server_mismatch");
  });

  it("refuses a manual OAuth client for such an auth", async () => {
    const res = await app.request("/api/integrations/@myorg/forge/auths/oauth/oauth-clients", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: "manual", token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("per connection");
  });

  it("refreshes against the token endpoint of the client's own issuer", async () => {
    expect((await beginHosted(otherBase)).res.status).toBe(200);
    const [client] = await db
      .select()
      .from(integrationOauthClients)
      .where(
        and(
          eq(integrationOauthClients.integrationId, "@myorg/forge"),
          eq(integrationOauthClients.issuer, otherBase),
        ),
      );
    const auth = (forgeManifest("@myorg/forge").auths as Record<string, unknown>)
      .oauth as AfpsManifestAuth;
    const refresh = await buildIntegrationOAuthRefreshContext(
      "@myorg/forge",
      "oauth",
      auth,
      ctx.defaultSpaceId,
      { clientRef: client!.id, oauthResource: null },
    );
    expect(refresh!.tokenEndpoint).toBe(`${otherBase}/oauth/token`);
    expect(refresh!.clientId).toBe(client!.clientId);
    expect(refresh!.tokenEndpointAuthMethod).toBe("none");
    expect(refresh).not.toHaveProperty("resource");
  });
});
