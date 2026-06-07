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
 * clients can discover this instance's authorization server, and registers a
 * `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` challenge
 * (RFC 9728 §5.1) emitted on the 401 (no/invalid token) and the 403
 * (insufficient scope) via the generic auth-challenge registry — the trigger
 * that lets a tokenless client start the OAuth flow.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@appstrate/mcp-transport";
import { requireModulePermission } from "@appstrate/core/permissions";
import { methodNotAllowed, unauthorized } from "../../lib/errors.ts";
import { rateLimitMcp } from "../../middleware/rate-limit.ts";
import { logger } from "../../lib/logger.ts";
import { registerAuthChallenge } from "../../lib/auth-challenges.ts";
import { recordAuditFromContext } from "../../services/audit.ts";
import type { AppEnv } from "../../types/index.ts";
import { getPlatformApp } from "../../lib/platform-app.ts";
import { getMcpResourceUri } from "./resource.ts";
import { buildMcpTools, type Dispatch, type McpObserver } from "./tools.ts";

const MCP_SERVER_VERSION = "1.0.0";
const MCP_PATH = "/api/mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";
/** Scopes this resource accepts — advertised in PRM + the 401/403 challenge. */
const MCP_SCOPES = ["mcp:read", "mcp:invoke"] as const;
// JSON-RPC envelope-granularity limit per caller per minute. Sized for
// interactive agent loops (search → describe → invoke, repeated) while still
// bounding cheap abuse of search/describe, which touch no rate-limited route.
const MCP_RATE_LIMIT_PER_MIN = 120;

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

/**
 * RFC 8707 resource-server audience binding. The MCP spec requires the server
 * to "validate that access tokens were issued specifically for them" and
 * "reject tokens that do not include them in the audience claim".
 *
 * Only OAuth Bearer tokens carry an audience (the oidc strategy surfaces it as
 * `authExtra.tokenAudiences`). When present, the token MUST list this server's
 * canonical resource URI; otherwise it was issued for a different resource and
 * is rejected with 401 (the challenge responder then attaches the
 * `WWW-Authenticate` so the client can re-acquire a correctly-scoped token).
 *
 * Cookie sessions and API keys carry no token audience (`tokenAudiences`
 * undefined) → first-party callers are unaffected. An MCP-audience token that
 * reaches other platform routes is contained by RBAC (it holds only mcp:*
 * permissions), so this check is the MCP-direction half of audience isolation.
 */
export const requireMcpAudience = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  const extra = c.get("authExtra") as { tokenAudiences?: unknown } | undefined;
  const audiences = extra?.tokenAudiences;
  // No bearer-token audience → cookie/API-key first-party caller. Allow.
  if (!Array.isArray(audiences)) return next();
  if (!audiences.includes(getMcpResourceUri())) {
    throw unauthorized("Access token is not audience-bound to this MCP resource.");
  }
  return next();
};

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
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${origin}/api/docs`,
    });
  };
  app.get(PRM_PATH, protectedResourceMetadata);
  app.get(`${PRM_PATH}${MCP_PATH}`, protectedResourceMetadata);

  // RFC 9728 §5.1 challenge: on a 401 (no/invalid token) or 403 (insufficient
  // scope) the generic responder attaches this so a spec-compliant client
  // (Claude Code, …) discovers the PRM URL and starts/steps-up an OAuth flow.
  // Point at the path-insertion PRM variant (the form a strict client probes).
  registerAuthChallenge(MCP_PATH, ({ origin, status }) => {
    const resourceMetadata = `${origin}${PRM_PATH}${MCP_PATH}`;
    const base = `Bearer resource_metadata="${resourceMetadata}", scope="${MCP_SCOPES.join(" ")}"`;
    // 403 here means the caller authenticated but lacks an mcp scope — signal
    // step-up per RFC 6750 §3.1 so the client requests the missing scope.
    return status === 403 ? `${base}, error="insufficient_scope"` : base;
  });

  // Rate-limit before the permission check so repeated probing (including by a
  // caller that will 403) is bounded too. Auth runs earlier in the global
  // pipeline, so the identity is already resolved here.
  app.use(MCP_PATH, rateLimitMcp(MCP_RATE_LIMIT_PER_MIN));
  app.use(MCP_PATH, requireMcpAudience);
  app.use(MCP_PATH, requireModulePermission("mcp", "read"));

  app.post(MCP_PATH, async (c) => {
    const origin = new URL(c.req.url).origin;
    const permissions = c.get("permissions") ?? new Set<string>();
    const authHeaders = forwardAuthHeaders(c.req.raw.headers);
    const dispatch: Dispatch = async (req) => getPlatformApp().fetch(req);

    // Audit + telemetry sink. The tool layer emits plain data; here we decide
    // what to do with it: structured telemetry for every tool call, and a
    // durable audit row for invoke_operation outcomes (the underlying route
    // self-audits its own mutation, but the MCP indirection is recorded
    // separately so the trail shows the call arrived via MCP). Reads
    // (search/describe) are metadata browsing and are not audited.
    //
    // Audit inserts are collected and awaited before the response returns, so
    // the trail is not lost if the process is recycled between requests (the
    // insert is itself best-effort and never throws — recordAudit swallows).
    const pendingAudits: Promise<unknown>[] = [];
    const observe: McpObserver = (event) => {
      logger.info("mcp.tool_call", {
        requestId: c.get("requestId"),
        tool: event.tool,
        durationMs: Math.round(event.durationMs),
        operationId: event.operationId,
        method: event.method,
        path: event.path,
        status: event.status,
        outcome: event.outcome,
        resultCount: event.resultCount,
      });
      if (
        event.tool === "invoke_operation" &&
        (event.outcome === "invoked" || event.outcome === "denied")
      ) {
        pendingAudits.push(
          recordAuditFromContext(c, {
            action: event.outcome === "denied" ? "mcp.operation.denied" : "mcp.operation.invoked",
            resourceType: "mcp_operation",
            resourceId: event.operationId ?? null,
            after: {
              method: event.method ?? null,
              path: event.path ?? null,
              status: event.status ?? null,
              outcome: event.outcome,
            },
          }),
        );
      }
    };

    const tools = buildMcpTools({ origin, permissions, authHeaders, dispatch, observe });
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
    const forwarded = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      body: await raw.arrayBuffer(),
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(forwarded);
      // Flush audit inserts before responding so the trail survives a process
      // recycle. allSettled — a failed insert is already swallowed upstream.
      if (pendingAudits.length > 0) await Promise.allSettled(pendingAudits);
      return response;
    } finally {
      await transport.close();
      await server.close();
    }
  });

  // Stateless JSON-response transport serves no standalone server→client SSE
  // stream (GET) and has no session to terminate (DELETE), so POST is the only
  // meaningful verb. Reject everything else with 405 + `Allow: POST` rather
  // than letting the SDK open a dangling GET SSE stream that never receives a
  // message. Auth still runs first (global pipeline), so an unauthenticated
  // request of any verb is rejected with 401 before reaching here.
  app.all(MCP_PATH, () => {
    throw methodNotAllowed(["POST"]);
  });

  return app;
}
