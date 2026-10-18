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
  "mcp.reset.test",
  "mcp.notbearer.test",
  "mcp.blocked.test",
  "mcp.slow.test",
  "mcp.modern.test",
  "mcp.cimd.test",
  "mcp.cimdlocal.test",
  "mcp.offline.test",
  "mcp.online.test",
  "mcp.noscope.test",
  "mcp.guessoffline.test",
  "mcp.guessempty.test",
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
    cimd?: boolean;
    path?: string;
    /** The authorization server's own `scopes_supported`. */
    asScopes?: string[];
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
        ...(opts.cimd
          ? {
              client_id_metadata_document_supported: true,
              authorization_response_iss_parameter_supported: true,
            }
          : {}),
        ...(opts.asScopes ? { scopes_supported: opts.asScopes } : {}),
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

  it("requests offline_access when the authorization server advertises it (Appstrate)", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.offline.test", {
        prm: { scopes_supported: ["mcp:read", "mcp:invoke"] },
        asScopes: ["openid", "offline_access", "mcp:read", "mcp:invoke"],
      }),
    );
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.offline.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["mcp:read", "mcp:invoke", "offline_access"]);
  });

  it("adds no offline_access the authorization server does not advertise", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.online.test", {
        prm: { scopes_supported: ["mcp:read"] },
        asScopes: ["mcp:read"],
      }),
    );
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.online.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["mcp:read"]);
  });

  it("keeps an empty scope list empty, offline_access advertised or not", async () => {
    const { fetchImpl } = fakeFetch(
      protectedServer("mcp.noscope.test", { asScopes: ["openid", "offline_access"] }),
    );
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.noscope.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    // No scope named: the authorization server applies its defaults.
    expect(auth.default_scopes).toEqual([]);
  });

  /** An origin authorization server with DCR and no protected-resource metadata. */
  const guessedOrigin = (host: string, challenge: string) => {
    const origin = `https://${host}`;
    return fakeFetch({
      [`POST ${origin}/mcp`]: () => unauthorized(challenge),
      [`GET ${origin}/.well-known/oauth-authorization-server`]: () =>
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          scopes_supported: ["read", "offline_access"],
        }),
    });
  };

  it("adds offline_access on a guessed origin server that advertises it", async () => {
    const { fetchImpl } = guessedOrigin("mcp.guessoffline.test", 'Bearer scope="read"');
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.guessoffline.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual(["read", "offline_access"]);
  });

  it("keeps a guessed origin server's empty scope list empty", async () => {
    const { fetchImpl } = guessedOrigin("mcp.guessempty.test", 'Bearer realm="OAuth"');
    const { manifest } = await discoverRemoteIntegration(
      { url: "https://mcp.guessempty.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
    expect(auth.default_scopes).toEqual([]);
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

  describe("a server accepting only client metadata documents (CIMD, no DCR)", () => {
    const withAppUrl = async <T>(appUrl: string, fn: () => Promise<T>): Promise<T> => {
      const previous = process.env.APP_URL;
      process.env.APP_URL = appUrl;
      resetEnvCache();
      try {
        return await fn();
      } finally {
        if (previous === undefined) delete process.env.APP_URL;
        else process.env.APP_URL = previous;
        resetEnvCache();
      }
    };

    it("proposes a public client when the instance can serve its document", async () => {
      const { fetchImpl } = fakeFetch(
        protectedServer("mcp.cimd.test", { registration: false, cimd: true }),
      );
      const { manifest, warnings } = await withAppUrl("https://appstrate.example.com", () =>
        discoverRemoteIntegration(
          { url: "https://mcp.cimd.test/mcp", orgSlug: "acme" },
          { fetchImpl },
        ),
      );
      const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
      expect(auth.token_endpoint_auth_method).toBe("none");
      expect(warnings).toEqual([]);
    });

    it("asks for a manual client on an instance no server can fetch from (localhost)", async () => {
      const { fetchImpl } = fakeFetch(
        protectedServer("mcp.cimdlocal.test", { registration: false, cimd: true }),
      );
      const { manifest, warnings } = await withAppUrl("http://localhost:3000", () =>
        discoverRemoteIntegration(
          { url: "https://mcp.cimdlocal.test/mcp", orgSlug: "acme" },
          { fetchImpl },
        ),
      );
      const auth = (manifest.auths as Record<string, Record<string, unknown>>).oauth!;
      expect(auth.token_endpoint_auth_method).toBe("client_secret_post");
      expect(warnings.map((w) => w.code)).toEqual(["manual_client_required"]);
    });
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

  it("guesses a Bearer API key, shaped as the editor's, when nothing describes the auth", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.apikey.test/mcp": () => unauthorized("Bearer"),
    });
    const { manifest, provenance } = await discoverRemoteIntegration(
      { url: "https://mcp.apikey.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(manifest.auths).toEqual({
      primary: {
        type: "api_key",
        authorized_uris: ["https://mcp.apikey.test/**"],
        credentials: {
          schema: {
            type: "object",
            properties: {
              api_key: {
                type: "string",
                writeOnly: true,
              },
            },
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
        _meta: { "dev.appstrate/auth": { required: true } },
      },
    });
    expect(provenance["/auths/primary"]).toBe("guessed");
  });

  it("refuses a 401 that asks for no Bearer credential", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.notbearer.test/mcp": () => unauthorized('Basic realm="admin"'),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.notbearer.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect(err.code).toBe("not_an_mcp_server");
    const bare = fakeFetch({
      "POST https://mcp.notbearer.test/mcp": () => new Response("no", { status: 403 }),
    });
    const bareErr = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.notbearer.test/mcp", orgSlug: "acme" },
        { fetchImpl: bare.fetchImpl },
      ),
    );
    expect(bareErr.code).toBe("not_an_mcp_server");
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
      "GET https://mcp.legacyauth.test/events": () => unauthorized("Bearer"),
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

  it("refuses an open Streamable HTTP server", async () => {
    const notification = { jsonrpc: "2.0", method: "notifications/message", params: {} };
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.open.test/mcp": () =>
        new Response(
          // A notification may come before the response: it is skipped.
          `event: message\ndata: ${JSON.stringify(notification)}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "s-1" } },
        ),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.open.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect(err.code).toBe("remote_mcp_auth_not_supported");
  });

  it("reads a JSON answer larger than the probe's prefix as JSON-RPC", async () => {
    const result = { protocolVersion: "2025-11-25", instructions: "x".repeat(128 * 1024) };
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.open.test/mcp": () => json({ jsonrpc: "2.0", id: 1, result }),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.open.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect(err.code).toBe("remote_mcp_auth_not_supported");
  });

  it("probes with the MCP-Protocol-Version header both eras require", async () => {
    let header = null as string | null;
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.modern.test/mcp": (req) => {
        header = req.headers.get("mcp-protocol-version");
        return unauthorized("Bearer");
      },
    });
    await discoverRemoteIntegration(
      { url: "https://mcp.modern.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(header).toBe("2025-11-25");
  });

  /** A 2026-07-28 server refusing the legacy `initialize`, per its transport's server validation. */
  const modernRefusal = (status: number, error: Record<string, unknown>) =>
    fakeFetch({
      "POST https://mcp.modern.test/mcp": () => json({ jsonrpc: "2.0", id: 1, error }, status),
    });
  const discoverModern = (fetchImpl: typeof fetch) =>
    refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.modern.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );

  it("refuses a modern-only server, naming the versions it serves", async () => {
    const { fetchImpl, seen } = modernRefusal(400, {
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28"], requested: "2025-11-25" },
    });
    const err = await discoverModern(fetchImpl);
    expect({ status: err.status, code: err.code }).toEqual({
      status: 422,
      code: "remote_mcp_modern_only",
    });
    expect(err.message).toContain("2026-07-28");
    expect(err.message).toContain("2025-11-25");
    expect(seen).toEqual(["POST https://mcp.modern.test/mcp"]);
  });

  it("reads a JSON-RPC error on a 400 or 404 as an open MCP server", async () => {
    const versions = modernRefusal(400, {
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: ["2026-07-28", "2025-11-25"], requested: "1900-01-01" },
    });
    const unknownMethod = modernRefusal(404, { code: -32601, message: "Method not found" });
    for (const { fetchImpl, seen } of [versions, unknownMethod]) {
      const err = await discoverModern(fetchImpl);
      expect({ status: err.status, code: err.code }).toEqual({
        status: 422,
        code: "remote_mcp_auth_not_supported",
      });
      // No fallback to the SSE transport: the server spoke JSON-RPC.
      expect(seen).toEqual(["POST https://mcp.modern.test/mcp"]);
    }
  });

  it("reads a header mismatch as a server serving only the stateless revision", async () => {
    const { fetchImpl, seen } = modernRefusal(400, { code: -32020, message: "Header mismatch" });
    const err = await discoverModern(fetchImpl);
    expect({ status: err.status, code: err.code }).toEqual({
      status: 422,
      code: "remote_mcp_modern_only",
    });
    expect(err.message).toContain("2026-07-28 or later");
    expect(seen).toEqual(["POST https://mcp.modern.test/mcp"]);
  });

  it("falls back to the SSE GET past a generic JSON-RPC error on a 405", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "POST https://mcp.legacyauth.test/events": () =>
        json(
          { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
          405,
        ),
      "GET https://mcp.legacyauth.test/events": () => unauthorized("Bearer"),
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

  it("refuses a 400 that carries no JSON-RPC error", async () => {
    for (const body of ["bad request", JSON.stringify({ error: "bad" }), ""]) {
      const { fetchImpl } = fakeFetch({
        "POST https://mcp.modern.test/mcp": () => new Response(body, { status: 400 }),
      });
      expect((await discoverModern(fetchImpl)).code).toBe("not_an_mcp_server");
    }
  });

  it("names only the origin in a refusal: a path or query may carry a secret", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://www.html.test/mcp?key=s3cret": () =>
        new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://www.html.test/mcp?key=s3cret", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect(err.code).toBe("not_an_mcp_server");
    expect(err.message).toContain("https://www.html.test");
    expect(err.message).not.toContain("s3cret");
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

  it("answers 502 when the answer's body fails mid-read", async () => {
    const { fetchImpl } = fakeFetch({
      "POST https://mcp.reset.test/mcp": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message\n"));
              controller.error(new Error("connection reset"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.reset.test/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect({ status: err.status, code: err.code }).toEqual({ status: 502, code: "bad_gateway" });
  });

  it("warns that a blocked authorization server was not read", async () => {
    const { fetchImpl, seen } = fakeFetch({
      ...protectedServer("mcp.blocked.test"),
      "GET https://mcp.blocked.test/.well-known/oauth-protected-resource/mcp": () =>
        json({
          resource: "https://mcp.blocked.test/mcp",
          authorization_servers: ["https://10.0.0.1"],
        }),
    });
    const { warnings } = await discoverRemoteIntegration(
      { url: "https://mcp.blocked.test/mcp", orgSlug: "acme" },
      { fetchImpl },
    );
    expect(warnings.map((w) => w.code)).toEqual(["authorization_server_blocked"]);
    expect(seen.some((key) => key.includes("10.0.0.1"))).toBe(false);
  });

  /** Answers like `inner`, except the URLs `hangs` names, which wait for their signal. */
  const hanging = (inner: typeof fetch, hangs: (url: string) => boolean) =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      hangs(String(input))
        ? new Promise<Response>((_, reject) => {
            const signal = init!.signal!;
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason));
          })
        : inner(input, init)) as typeof fetch;

  it("answers 502 when the auth metadata outlasts the deadline", async () => {
    const { fetchImpl } = fakeFetch(protectedServer("mcp.slow.test"));
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.slow.test/mcp", orgSlug: "acme" },
        {
          fetchImpl: hanging(fetchImpl, (url) => url.includes("oauth-protected-resource")),
          signal: AbortSignal.timeout(50),
        },
      ),
    );
    expect({ status: err.status, code: err.code }).toEqual({ status: 502, code: "bad_gateway" });
  });

  it("proposes without an icon when only the icon outlasts the deadline", async () => {
    const { fetchImpl } = fakeFetch(protectedServer("mcp.slow.test"));
    const proposal = await discoverRemoteIntegration(
      { url: "https://mcp.slow.test/mcp", orgSlug: "acme" },
      {
        fetchImpl: hanging(fetchImpl, (url) => new URL(url).pathname === "/"),
        signal: AbortSignal.timeout(50),
      },
    );
    expect(proposal.iconSource).toBeNull();
    expect(Object.keys(proposal.manifest.auths as object)).toEqual(["oauth"]);
  });

  it("refuses a private address and plain http before any request", async () => {
    const { fetchImpl, seen } = fakeFetch({});
    for (const url of ["https://10.0.0.1/mcp", "http://mcp.example.com/mcp"]) {
      const err = await refusal(discoverRemoteIntegration({ url, orgSlug: "acme" }, { fetchImpl }));
      expect({ status: err.status, param: err.param }).toEqual({ status: 400, param: "url" });
    }
    expect(seen).toEqual([]);
  });

  it("tells an unresolvable host from a private address", async () => {
    const { fetchImpl, seen } = fakeFetch({});
    const err = await refusal(
      discoverRemoteIntegration(
        { url: "https://mcp.nowhere.invalid/mcp", orgSlug: "acme" },
        { fetchImpl },
      ),
    );
    expect({ status: err.status, param: err.param, detail: err.message }).toEqual({
      status: 400,
      param: "url",
      detail: "The host of the URL could not be resolved.",
    });
    expect(seen).toEqual([]);
  });
});

describe("hostDisplayName", () => {
  it("capitalises the registrable label", () => {
    expect(hostDisplayName("https://mcp.notion.com/mcp")).toBe("Notion");
    expect(hostDisplayName("https://mcp.example.co.uk/mcp")).toBe("Example");
    expect(hostDisplayName("https://localhost:3000/mcp")).toBe("Localhost");
    expect(hostDisplayName("http://127.0.0.1:3000/mcp")).toBe("127.0.0.1");
  });
});
