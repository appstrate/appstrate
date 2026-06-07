// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/mcp` — the platform's inbound MCP server (Streamable HTTP, stateless).
 *
 * Mounted under `/api`, so the platform auth pipeline runs first: the caller
 * is authenticated (session cookie, API key, or OIDC Bearer) and an
 * unauthenticated request is rejected with the standard platform 401 before
 * any tool runs. `requireModulePermission("mcp", "read")` then gates access.
 * Tool invocation re-enters the platform in-process (`app.fetch`) with the
 * caller's auth forwarded — see ./tools.ts.
 *
 * Also serves RFC 9728 Protected Resource Metadata so spec-compliant MCP
 * clients can discover this instance's authorization server. (Emitting the
 * `WWW-Authenticate: ... resource_metadata=` challenge on the 401 — RFC 9728
 * §5.1 — is a follow-up: the platform auth pipeline owns the 401 response.)
 */

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@appstrate/mcp-transport";
import { requireModulePermission } from "@appstrate/core/permissions";
import type { AppEnv } from "../../types/index.ts";
import { getPlatformApp } from "../../lib/platform-app.ts";
import { buildMcpTools, type Dispatch } from "./tools.ts";

const MCP_SERVER_VERSION = "1.0.0";
const MCP_PATH = "/api/mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";

/** Auth-relevant headers forwarded onto in-process dispatched requests. */
const FORWARDED_AUTH_HEADERS = [
  "authorization",
  "cookie",
  "x-org-id",
  "x-application-id",
  "appstrate-user",
  "appstrate-version",
];

function forwardAuthHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_AUTH_HEADERS) {
    const value = src.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

export function createMcpRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // RFC 9728 Protected Resource Metadata — public (declared in module
  // publicPaths). Points clients at this instance's OAuth authorization
  // server (served by the oidc module at /.well-known/oauth-authorization-server).
  app.get(PRM_PATH, (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/api/docs`,
    });
  });

  app.use(MCP_PATH, requireModulePermission("mcp", "read"));

  app.all(MCP_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const permissions = c.get("permissions") ?? new Set<string>();
    const authHeaders = forwardAuthHeaders(c.req.raw.headers);
    const dispatch: Dispatch = async (req) => getPlatformApp().fetch(req);

    const tools = buildMcpTools({ origin, permissions, authHeaders, dispatch });
    const server = createMcpServer(tools, { name: "appstrate", version: MCP_SERVER_VERSION });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Host-header / DNS-rebinding is handled upstream by CORS + the
      // platform's trusted-origin config; the transport check would reject
      // legitimate reverse-proxied hosts.
      enableDnsRebindingProtection: false,
    });

    // Reconstruct the request so the SDK transport can read the body once.
    const raw = c.req.raw;
    let forwarded = raw;
    if (raw.method === "POST" || raw.method === "PUT" || raw.method === "PATCH") {
      forwarded = new Request(raw.url, {
        method: raw.method,
        headers: raw.headers,
        body: await raw.arrayBuffer(),
      });
    }

    try {
      await server.connect(transport);
      return await transport.handleRequest(forwarded);
    } finally {
      await transport.close();
      await server.close();
    }
  });

  return app;
}
