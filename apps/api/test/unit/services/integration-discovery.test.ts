// SPDX-License-Identifier: Apache-2.0

/**
 * `discoverRemoteIntegration` against scripted servers shaped like the live
 * ones (Notion, Linear, Sentry, Atlassian, an SSE server, an open server). The
 * fetch is injected; the hosts are on the operator allowlist so the egress
 * pre-check needs no DNS.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { _resetCacheForTesting as resetEnvCache } from "@appstrate/env";
import { ApiError } from "../../../src/lib/errors.ts";
import {
  discoverRemoteIntegration,
  hostDisplayName,
} from "../../../src/services/integration-discovery.ts";

type Route = (req: Request) => Response | Promise<Response>;

const HOSTS = [
  "mcp.notion.test",
  "mcp.linear.test",
  "mcp.sentry.test",
  "mcp.atlassian.test",
  "mcp.apikey.test",
  "mcp.legacy.test",
  "mcp.legacyauth.test",
  "mcp.asana.test",
  "mcp.open.test",
  "www.html.test",
  "mcp.manual.test",
  "mcp.scopes.test",
  "mcp.down.test",
];

let previousAllowlist: string | undefined;
beforeAll(() => {
  previousAllowlist = process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
  process.env.EGRESS_ALLOW_INTERNAL_HOSTS = HOSTS.join(",");
  resetEnvCache();
});
afterAll(() => {
  if (previousAllowlist === undefined) delete process.env.EGRESS_ALLOW_INTERNAL_HOSTS;
  else process.env.EGRESS_ALLOW_INTERNAL_HOSTS = previousAllowlist;
  resetEnvCache();
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const unauthorized = (challenge: string) =>
  new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": challenge } });

/** Routes keyed `METHOD url`; anything else is a 404. Records every request. */
function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(String(input), init);
    const key = `${req.method} ${req.url}`;
    seen.push(key);
    const route = routes[key];
    return route ? route(req) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** A protected MCP server publishing RFC 9728 metadata and an RFC 8414 document. */
function protectedServer(
  host: string,
  opts: {
    challengeScope?: string;
    prm?: Record<string, unknown>;
    registration?: boolean;
    path?: string;
  } = {},
): Record<string, Route> {
  const origin = `https://${host}`;
  const path = opts.path ?? "/mcp";
  const prmUrl = `${origin}/.well-known/oauth-protected-resource${path}`;
  const scope = opts.challengeScope === undefined ? "" : `, scope="${opts.challengeScope}"`;
  return {
    [`POST ${origin}${path}`]: () => unauthorized(`Bearer resource_metadata="${prmUrl}"${scope}`),
    [`GET ${prmUrl}`]: () =>
      json({ resource: `${origin}${path}`, authorization_servers: [origin], ...opts.prm }),
    [`GET ${origin}/.well-known/oauth-authorization-server`]: () =>
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        code_challenge_methods_supported: ["S256"],
        ...(opts.registration === false ? {} : { registration_endpoint: `${origin}/register` }),
      }),
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("discoverRemoteIntegration", () => {
  it("proposes a public-client oauth2 auth and the published name (Notion)", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.notion.test", {
        challengeScope: "default",
        prm: {
          scopes_supported: ["default"],
          resource_name: "Notion MCP (Beta)",
          resource_documentation: "https://developers.notion.test/mcp",
          resource_policy_uri: "https://notion.test/privacy",
        },
      }),
    );
    const proposal = await discoverRemoteIntegration(
      { url: "https://mcp.notion.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(proposal.manifest).toEqual({
      display_name: "Notion MCP (Beta)",
      name: "@acme/notion",
      documentation: "https://developers.notion.test/mcp",
      privacy_policies: ["https://notion.test/privacy"],
      source: {
        kind: "remote",
        remote: { url: "https://mcp.notion.test/mcp", transport: "streamable-http" },
      },
      auths: {
        oauth: {
          type: "oauth2",
          token_endpoint_auth_method: "none",
          default_scopes: ["default"],
          scope_catalog: [{ value: "default", label: "default" }],
          authorized_uris: ["https://mcp.notion.test/**"],
          delivery: {
            http: {
              in: "header",
              name: "Authorization",
              prefix: "Bearer ",
              value: "{$credential.access_token}",
            },
          },
          _meta: {
            "dev.appstrate/oauth": { scope_separator: " " },
            "dev.appstrate/auth": { required: true },
          },
        },
      },
    });
    expect(proposal.provenance).toEqual({
      "/display_name": "detected",
      "/name": "guessed",
      "/source/remote/transport": "guessed",
      "/auths/oauth": "detected",
      "/documentation": "detected",
      "/privacy_policies": "detected",
    });
    expect(proposal.warnings).toEqual([]);
    expect(proposal.iconSource).toBeNull();
  });

  it("takes the challenge's scopes as defaults, the catalog as their union (Linear)", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.linear.test", {
        challengeScope: "read write",
        prm: { scopes_supported: ["read", "write", "admin"] },
      }),
    );
    const { manifest, provenance } = await discoverRemoteIntegration(
      { url: "https://mcp.linear.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["read", "write"]);
    expect(auth.scope_catalog).toEqual([
      { value: "read", label: "read" },
      { value: "write", label: "write" },
      { value: "admin", label: "admin" },
    ]);
    // No `resource_name`: the host names it.
    expect(manifest.display_name).toBe("Linear");
    expect(manifest.name).toBe("@acme/linear");
    expect(provenance["/display_name"]).toBe("guessed");
  });

  it("falls back to scopes_supported without a challenge scope (Sentry)", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.sentry.test", {
        prm: { scopes_supported: ["org:read", "event:write"] },
      }),
    );
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.sentry.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["org:read", "event:write"]);
  });

  it("drops scopes that are not one RFC 6749 scope token", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.scopes.test", { prm: { scopes_supported: ["ok", 'b"ad', "a\\b"] } }),
    );
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.scopes.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["ok"]);
    expect(auth.scope_catalog).toEqual([{ value: "ok", label: "ok" }]);
  });

  it("names the issuer and warns when the server offers no dynamic registration", async () => {
    const { fetchImpl } = fakeFetch(protectedServer("mcp.manual.test", { registration: false }));
    const { manifest, warnings } = await discoverRemoteIntegration(
      { url: "https://mcp.manual.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.token_endpoint_auth_method).toBe("client_secret_post");
    expect(auth.issuer).toBe("https://mcp.manual.test");
    expect(warnings.map((w) => w.code)).toEqual(["manual_client_required"]);
  });

  it("guesses oauth2 on the origin's server without protected-resource metadata (Atlassian)", async () => {
    const origin = "https://mcp.atlassian.test";
    const { fetchImpl } = fakeFetch({
      [`POST ${origin}/v1/mcp`]: () => unauthorized('Bearer realm="OAuth", error="invalid_token"'),
      [`GET ${origin}/.well-known/oauth-authorization-server`]: () =>
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
        }),
    });
    const { manifest, provenance } = await discoverRemoteIntegration(
      { url: `${origin}/v1/mcp`, orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.issuer).toBe(origin);
    expect(auth.token_endpoint_auth_method).toBe("none");
    expect(provenance["/auths/oauth"]).toBe("guessed");
  });

  it("guesses a Bearer API key when nothing describes the auth", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.apikey.test/mcp": () => new Response("no", { status: 401 }),
    });
    const { manifest, provenance } = await discoverRemoteIntegration(
      { url: "https://mcp.apikey.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(manifest.auths).toEqual({
      api_key: {
        type: "api_key",
        authorized_uris: ["https://mcp.apikey.test/**"],
        credentials: {
          schema: {
            type: "object",
            properties: { token: { type: "string", writeOnly: true, title: "Jeton d'API" } },
            required: ["token"],
          },
        },
        delivery: {
          http: {
            in: "header",
            name: "Authorization",
            prefix: "Bearer ",
            value: "{$credential.token}",
          },
        },
        _meta: { "dev.appstrate/auth": { required: true } },
      },
    });
    expect(provenance["/auths/api_key"]).toBe("guessed");
  });

  it("guesses the SSE transport from an /sse path", async () => {
    const { fetchImpl } = fakeFetch(protectedServer("mcp.asana.test", { path: "/sse" }));
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.asana.test/sse", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(manifest.source).toEqual({
      kind: "remote",
      remote: { url: "https://mcp.asana.test/sse", transport: "sse" },
    });
  });

  it("falls back to the SSE GET on a 405, and reads its challenge", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "POST https://mcp.legacyauth.test/events": () => new Response(null, { status: 405 }),
      "GET https://mcp.legacyauth.test/events": () => new Response("no", { status: 401 }),
    });
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.legacyauth.test/events", orgSlug: "acme" },
      { fetchImpl },
    );
    expect((manifest.source as { remote: { transport: string } }).remote.transport).toBe("sse");
    expect(seen.slice(0, 2)).toEqual([
      "POST https://mcp.legacyauth.test/events",
      "GET https://mcp.legacyauth.test/events",
    ]);
  });

  it("refuses an open SSE server (endpoint event, no auth)", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.legacy.test/sse": () => new Response(null, { status: 405 }),
      "GET https://mcp.legacy.test/sse": () =>
        new Response("event: endpoint\ndata: /messages?session=1\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.legacy.test/sse", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect({ status: err.status, code: err.code }).toEqual({
      status: 422,
      code: "remote_mcp_auth_not_supported",
    });
  });

  it("refuses an open Streamable HTTP server and ends the session it opened", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "POST https://mcp.open.test/mcp": () =>
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-1" } },
        ),
      "DELETE https://mcp.open.test/mcp": () => new Response(null, { status: 204 }),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.open.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect(err.code).toBe("remote_mcp_auth_not_supported");
    await Bun.sleep(0);
    expect(seen).toContain("DELETE https://mcp.open.test/mcp");
  });

  it("refuses a URL that is not an MCP server", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://www.html.test/": () =>
        new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    });
    const err = await refusal(
      discoverRemoteIntegration({ url: "https://www.html.test/", orgSlug: "acme" }, { fetchImpl }),
    );
    expect({ status: err.status, code: err.code }).toEqual({
      status: 422,
      code: "not_an_mcp_server",
    });
  });

  it("answers 502 when the server cannot be reached", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.down.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect({ status: err.status, code: err.code }).toEqual({ status: 502, code: "bad_gateway" });
  });

  it("refuses a private address and plain http before any request", async () => {
    const { fetchImpl, seen } = fakeFetch({});
    for (const url of ["https://10.0.0.1/mcp", "http://mcp.example.com/mcp"]) {
      const err = await refusal(discoverRemoteIntegration({ url, orgSlug: "acme" }, { fetchImpl }));
      expect({ status: err.status, param: err.param }).toEqual({ status: 400, param: "url" });
    }
    expect(seen).toEqual([]);
  });
});

describe("hostDisplayName", () => {
  it("capitalises the registrable label", () => {
    expect(hostDisplayName("https://mcp.notion.com/mcp")).toBe("Notion");
    expect(hostDisplayName("https://localhost:3000/mcp")).toBe("Localhost");
    expect(hostDisplayName("http://127.0.0.1:3000/mcp")).toBe("127.0.0.1");
  });
});
