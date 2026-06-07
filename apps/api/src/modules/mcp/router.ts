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
import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@appstrate/mcp-transport";
import { requireModulePermission } from "@appstrate/core/permissions";
import type { AppEnv } from "../../types/index.ts";
import { getPlatformApp } from "../../lib/platform-app.ts";
import { buildMcpTools, type Dispatch } from "./tools.ts";

const MCP_SERVER_VERSION = "1.0.0";
const MCP_PATH = "/api/mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";

/**
 * Server `instructions` injected into the client's system prompt at
 * `initialize`. Deliberately meta and maintenance-free: it carries ONLY the
 * cross-cutting context the tool descriptions and per-operation OpenAPI
 * schemas can't (purpose, entity model, the `@` scope rule, async-run +
 * SSE-not-callable behaviour). It never lists tools, counts, tags, or
 * endpoints — those are discovered at runtime, so the surface can grow
 * without touching this text.
 */
const SERVER_INSTRUCTIONS = `Appstrate runs autonomous AI agents in sandboxed Docker containers. The tools here let you discover and call any operation of the Appstrate REST API — their own descriptions tell you how. Never guess an operationId or body shape; the describe step is the source of truth, and the surface is not fixed — if a capability might exist, search for it.

## Core model
Organization → Applications (id \`app_…\`, one default) → Agents → Runs. End-users (\`eu_…\`) are external identities for embedded use. Packages (agents, integrations, skills…) are identified as \`@scope/name\` (e.g. \`@appstrate/my-agent\`). Depending on the operation this is passed either as a single \`packageId\` param or split into separate \`scope\` and \`name\` params — describe_operation shows which; always keep the \`@\`, and the \`/\` when it's a single param.

## Beyond the per-operation schemas
- Runs are asynchronous: triggering one returns a runId, then it moves pending→running→success|failed|timeout|cancelled — poll a run get/list operation for status.
- Streaming/SSE operations (live logs, realtime) cannot be called through this server; fetch logs or poll instead.
- Wire JSON is snake_case, except universal id/timestamp fields (id, createdAt…) which stay camelCase.`;

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
  //
  // Served at BOTH the bare well-known and the path-insertion variant
  // (`/.well-known/oauth-protected-resource/api/mcp`): RFC 9728 §3.1 has a
  // client derive the metadata URL by inserting the well-known segment before
  // the resource's path, so a strict client probes the suffixed form.
  const protectedResourceMetadata = (c: Context<AppEnv>) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      scopes_supported: ["mcp:read", "mcp:invoke"],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/api/docs`,
    });
  };
  app.get(PRM_PATH, protectedResourceMetadata);
  app.get(`${PRM_PATH}${MCP_PATH}`, protectedResourceMetadata);

  app.use(MCP_PATH, requireModulePermission("mcp", "read"));

  app.all(MCP_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const permissions = c.get("permissions") ?? new Set<string>();
    const authHeaders = forwardAuthHeaders(c.req.raw.headers);
    const dispatch: Dispatch = async (req) => getPlatformApp().fetch(req);

    const tools = buildMcpTools({ origin, permissions, authHeaders, dispatch });
    const server = createMcpServer(
      tools,
      { name: "appstrate", version: MCP_SERVER_VERSION },
      { instructions: SERVER_INSTRUCTIONS },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Disabled deliberately: the SDK's Host-header allowlist would reject
      // legitimate reverse-proxied hosts, and the rebinding threat it guards
      // (a browser tricked into POSTing to a localhost MCP server) doesn't
      // apply here — `/api/mcp` requires platform auth (Bearer/API key, or a
      // SameSite session cookie), so a cross-site page cannot drive it.
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
