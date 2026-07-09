// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/mcp/o/:org` — the platform's inbound MCP server, exposed ONCE PER
 * ORGANIZATION (Streamable HTTP, stateless). `:org` is the organization id
 * (uuid).
 *
 * There is no bare `/api/mcp` endpoint: a token is RFC 8707 audience-bound to
 * ONE org's canonical resource URI (`${APP_URL}/api/mcp/o/<orgId>`), so it is
 * confined to that organization — least privilege by construction. Multi-org
 * access means several MCP server entries client-side, each with its own token.
 *
 * Mounted under `/api`, so the platform auth pipeline runs first: the caller is
 * authenticated (session cookie, API key, or OIDC Bearer), the audience check
 * confirms a Bearer token is bound to THIS org's resource, and the org-context
 * middleware membership-checks and pins the org — all before any tool runs. An
 * unauthenticated request is rejected with the standard platform 401.
 * `requireModulePermission("mcp", "read")` then gates access, and an org guard
 * asserts the resolved org equals `:org` (defence in depth, and the
 * authoritative check for API-key callers whose org comes from the key, not the
 * token audience). Tool invocation re-enters the platform in-process
 * (`app.fetch`) with the caller's auth forwarded — see ./tools.ts.
 *
 * Also serves RFC 9728 Protected Resource Metadata PER ORG so spec-compliant
 * MCP clients can discover this instance's authorization server, and registers
 * a `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` challenge
 * (RFC 9728 §5.1) emitted on the 401 (no/invalid token) and the 403
 * (insufficient scope) via the generic auth-challenge registry — the trigger
 * that lets a tokenless client start the OAuth flow against the right org.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@appstrate/mcp-transport";
import { getEnv } from "@appstrate/env";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import { requireModulePermission } from "@appstrate/core/permissions";
import { forbidden, methodNotAllowed, notFound } from "../../lib/errors.ts";
import { rateLimitMcp } from "../../middleware/rate-limit.ts";
import { logger } from "../../lib/logger.ts";
import { registerAuthChallenge } from "../../lib/auth-challenges.ts";
import { registerProtectedResourceFamily } from "../../lib/protected-resources.ts";
import { recordAuditFromContext } from "../../services/audit.ts";
import type { AppEnv } from "../../types/index.ts";
import { dispatchInProcess } from "../../lib/platform-app.ts";
import { getMcpOrgResourceUri, orgIdFromMcpAudience } from "./audiences.ts";
import { buildMcpTools, FORWARDED_AUTH_HEADERS, type Dispatch, type McpObserver } from "./tools.ts";
import { buildOperationIndex } from "./catalog.ts";

const MCP_SERVER_VERSION = "1.0.0";
/** Path prefix owning the per-org sub-tree. `:org` is the organization id. */
const MCP_PREFIX = "/api/mcp/o";
/** The per-org POST endpoint, parameterised on the org id. */
const MCP_PATH = `${MCP_PREFIX}/:org`;
/**
 * RFC 9728 §3.1 path-insertion well-known for the per-org resource: the
 * metadata URL is built by inserting the well-known segment BEFORE the
 * resource's path, so a strict client probes `…/oauth-protected-resource` +
 * `/api/mcp/o/:org`. The bare well-known is gone (no single generic resource).
 */
const PRM_PATH_PREFIX = "/.well-known/oauth-protected-resource";
const PRM_PATH = `${PRM_PATH_PREFIX}${MCP_PATH}`;
/** Scopes this resource accepts — advertised in PRM + the 401/403 challenge. */
const MCP_SCOPES = ["mcp:read", "mcp:invoke"] as const;

// GUID-shaped (8-4-4-4-12 hex), NOT strict RFC version/variant — the security
// property is "no character that re-encodes" (rejects `/`, `.`, `%2F`, …), not
// which UUID version minted the id. `z.guid()` is the loose form; `z.uuid()`
// would additionally pin version/variant bits, which this check does not need.
const orgIdSchema = z.guid();

/**
 * Whether `:org` is a well-formed `organizations.id`. Validated before it reaches
 * either confinement check: the inbound audience guard derives the resource URI
 * from `c.req.path` (which preserves `%2F` / `%2E`), while the org-guard below
 * compares `c.req.param("org")` (which decodes them) — two normalizations of the
 * same segment. Rejecting anything that is not a bare GUID up front means a
 * crafted segment (`%2F`, `.`, `..`, sub-paths) can never reach, and be
 * normalized differently by, the two checks. Org ids never contain re-encodable
 * chars, so this rejects nothing legitimate.
 */
function isCanonicalOrgId(org: string | undefined): org is string {
  return org !== undefined && orgIdSchema.safeParse(org).success;
}

/**
 * Parse the org-id segment out of a path under the per-org family
 * (`/api/mcp/o/<id>` and any sub-path), returning the canonical per-org
 * resource URI or `undefined` when the path is malformed (no org segment, or an
 * org segment that is itself empty). Used by `registerProtectedResourceFamily`
 * to derive a request path's resource URI for inbound audience enforcement.
 *
 * Path forms it accepts: exactly `/api/mcp/o/<id>` and `/api/mcp/o/<id>/...`.
 * The first path segment after the prefix is the org id; anything after it
 * (the stateless transport never uses sub-paths, but be defensive) is ignored
 * for URI derivation. The derived URI is always the canonical org URI, so it
 * matches the token `aud` byte-for-byte regardless of trailing structure.
 */
function deriveOrgResourceUri(path: string): string | undefined {
  const prefix = `${MCP_PREFIX}/`;
  if (!path.startsWith(prefix)) return undefined;
  const orgId = path.slice(prefix.length).split("/")[0] ?? "";
  if (orgId.length === 0) return undefined;
  return getMcpOrgResourceUri(orgId);
}
// JSON-RPC envelope-granularity limit per caller per minute. Sized for
// interactive agent loops (search → describe → invoke, repeated) while still
// bounding cheap abuse of search/describe, which touch no rate-limited route.
const MCP_RATE_LIMIT_PER_MIN = 120;

/**
 * Server `instructions` injected into the client's system prompt at
 * `initialize`. Carries the cross-cutting context the tool descriptions and
 * per-operation OpenAPI schemas can't (purpose, entity model, the `@` scope
 * rule, async-run + SSE-not-callable behaviour), plus a GENERATED operation
 * index (`buildOperationIndex()`) so a client can pick an operationId directly
 * and skip a search_operations round-trip.
 *
 * Still maintenance-free: the index is derived from the live catalog, so the
 * surface grows without editing this text. describe_operation (or
 * search_operations' best_match) remains the source of truth for input schemas.
 */
function buildServerInstructions(
  permissions?: ReadonlySet<string>,
  contextInjected = false,
): string {
  // A `contextInjected` caller (the chat module) already injects the get_me
  // payload into its own system prompt and we drop the get_me tool for it, so
  // pushing "call get_me first" would point the model at a tool that isn't
  // there. Tell it the context is already provided instead.
  const grounding = contextInjected
    ? "Your caller context — who you are acting for, your role in this organization, and which integrations are already connected (prefer those when building or configuring an agent) — is already provided to you; there is no get_me tool, do not look for one."
    : "Start by calling get_me to learn who you are acting for, your role in this organization, and which integrations are already connected (prefer those when building or configuring an agent).";
  return `Appstrate runs autonomous AI agents in sandboxed Docker containers. The tools here let you discover and call any operation of the Appstrate REST API — their own descriptions tell you how. ${grounding} The operation index at the end of these instructions lists the operations available to your role by tag; it is your primary way to find an operation. Default to picking an operationId straight from that index, then call describe_operation for its input schema and invoke_operation to run it. Reach for search_operations only when the index is genuinely ambiguous or a capability you expect isn't listed — not as a routine first step. Never guess an operationId or body shape: describe_operation (or search_operations' best_match) is the source of truth for the input schema. Exception: when you need to launch or wait on an agent run, do not call runAgent, runInline, or getRun through invoke_operation; use the run_and_wait tool directly.

## Core model
Organization → Applications (id \`app_…\`, one default) → Agents → Runs. End-users (\`eu_…\`) are external identities for embedded use. Packages (agents, integrations, skills…) are identified as \`@scope/name\` (e.g. \`@appstrate/my-agent\`). Depending on the operation this is passed either as a single \`packageId\` param or split into separate \`scope\` and \`name\` params — describe_operation shows which; always keep the \`@\`, and the \`/\` when it's a single param.

## Org & application context
This MCP server is scoped to ONE organization — the one this endpoint serves — and every operation runs against it plus its default application; you never send those ids per call. To act in another organization, connect that organization's own MCP server (its URL carries its id). Within the org, operations use the default application unless an operation takes an explicit application id.

## Beyond the per-operation schemas
- Runs are asynchronous: triggering one returns the created run resource (use its \`id\`), then it moves pending→running→success|failed|timeout|cancelled. For runs you are launching now, use \`run_and_wait\` instead of manually composing \`runAgent\`/\`runInline\` plus \`getRun\`; it handles launch and waiting in one call. Use \`getRun\` with \`query: { wait: true }\` only when you are inspecting or waiting on an existing run that was not launched through \`run_and_wait\` in this turn.
- Shortcut — \`run_and_wait\` launches a run, exposes the created run to chat for live progress, then waits internally and returns \`{ id, packageId, status, done:true, result?, error? }\` once the run is terminal. This is the only tool you should use to launch agent runs. Do NOT call \`invoke_operation\` with \`runAgent\` or \`runInline\`, do NOT call \`describe_operation\` just to learn launch schemas, and do NOT call \`getRun\` after \`run_and_wait\` just to wait for completion. The chat shows ONLY lines the run emits via the \`log\` runtime tool — so for an inline run you MUST declare \`"runtime_tools": ["log"]\` in the manifest and instruct it (in the \`prompt\`) to call \`log\` at each meaningful step, or the in-chat run progress component stays empty.
- Streaming/SSE operations (live logs, realtime) cannot be called through this server; fetch logs or poll instead.
- Wire JSON is snake_case, except universal id/timestamp fields (id, createdAt…) which stay camelCase.
- Heavy list responses — list operations paginate with \`query: { limit, offset }\`, and some (e.g. \`listIntegrations\`) also take a \`fields\` selector (comma-separated projection; describe_operation shows it when available). On heavy lists request only the fields you need — e.g. \`fields: "id,active,block_user_connections"\` on \`listIntegrations\` — and read a single row's detail operation when you need its full \`manifest\`.
- Integration tool selection — an agent's \`integrations_configuration[id].tools\` resolves as: omitted/undefined → inherits the integration's \`default_tools\`; \`[]\` → no tools (overrides the default, the integration is inert); \`["a","b"]\` → exactly those tools; \`"*"\` → all upstream tools (requires \`allow_undeclared_tools\`). An integration's \`default_tools\` and full \`tool_catalog\` are on its detail operation (\`GET /api/integrations/{packageId}\`); read it before selecting tools so you pick real tool names and know what the default already covers.
- Integration preference — when a task needs an integration, prefer in order: (1) one the caller has already connected (listed in your caller context / get_me — connecting it was an explicit choice), then (2) one that is activated for this application but not yet connected, then (3) one that is neither. \`GET /api/integrations\` lists every integration with an \`active\` flag (activated for this app) and \`block_user_connections\`; use it to tell tiers 2 and 3 apart. Do not silently activate or connect an integration the caller did not ask for — surface that it would be needed and let them decide.
- Connecting or reconnecting an integration before a run — an integration may be unconnected, expired, needs-reconnection, under-scoped, or otherwise unusable. Do NOT pre-validate just to launch a "do it now" inline run: \`run_and_wait\` already runs the same readiness preflight and returns a 400 without consuming credits when the manifest cannot run. If \`run_and_wait\` fails with field errors whose \`field\` is \`integrations.<id>\` (or if you intentionally call \`validateInlineRun\` only to iterate/check readiness without launching), that integration is not ready — whatever the \`code\` (\`not_connected\`, \`needs_reconnection\`, \`insufficient_scopes\`, \`auth_key_mismatch\`, …). For each such error you MUST start its connect flow (do not just describe it): CALL \`invoke_operation\` with \`operation_id: "initiateIntegrationConnect"\`, \`path_params: { packageId: "<id>", authKey: "<key>" }\` (the auth key is in \`manifest.auths\` of the integration row from \`GET /api/integrations\`). This op is auth-type-agnostic — it works for every auth (oauth2, api_key, basic, mtls, custom), so you never inspect the auth type yourself. If the error carries a \`connection_id\`, also pass \`body: { connection_id: "<that id>" }\` so the existing connection is reconnected/upgraded in place instead of duplicated. This tool call is what renders the one-click connect button (from its result); without it there is NO button, so never claim a button will appear unless you just made this exact call this turn. After the call, the client renders the connect button on its own from your tool result — your text must NOT duplicate it: do NOT paste the returned \`connect_url\`, do NOT describe the button or tell the caller where to click, do NOT restate the connection request. End your turn with ONE short sentence saying you'll continue once the integration is connected — do NOT poll, loop, wait, or run in the same turn. On a later turn, call \`run_and_wait\` again (or \`validateInlineRun\` if you are only checking readiness); when readiness passes, proceed with the run. (Non-interactive clients with no button can open the returned \`connect_url\`.)

${OPERATION_INDEX_HEADING}
${buildOperationIndex(permissions)}`;
}

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

  // Register the per-org protected-resource FAMILY (RFC 8707 audience binding).
  // The concrete resources are dynamic (one URI per org, orgs created at
  // runtime) so they cannot be enumerated at registration time — the family
  // owns the whole `/api/mcp/o` sub-tree:
  //   - `deriveUri(path)` maps a request path to its canonical per-org URI, so
  //     `enforceResourceAudience` (inbound) requires that exact URI in the
  //     token `aud` — a token for org A presented on `/api/mcp/o/B` is a
  //     mismatch and 401s.
  //   - `ownsUri(uri)` recognises a per-org URI as protected without a request
  //     path, for outbound confinement (a per-org token may not be replayed on
  //     a non-resource route) and the AS mint-time self-service gate.
  // `ownsUri` accepts exactly the URIs `deriveUri` emits: `orgIdFromMcpAudience`
  // returns an org id iff the URI is the canonical `${APP_URL}/api/mcp/o/<id>`.
  registerProtectedResourceFamily({
    prefix: MCP_PREFIX,
    deriveUri: deriveOrgResourceUri,
    ownsUri: (uri) => orgIdFromMcpAudience(uri) !== undefined,
  });

  // RFC 9728 Protected Resource Metadata, served PER ORG — public (declared in
  // module publicPaths). Points clients at this instance's OAuth authorization
  // server (served by the oidc module at /.well-known/oauth-authorization-server).
  //
  // Served at the path-insertion variant only
  // (`/.well-known/oauth-protected-resource/api/mcp/o/:org`): RFC 9728 §3.1 has
  // a client derive the metadata URL by inserting the well-known segment before
  // the resource's path. There is no bare well-known — there is no single
  // generic resource to describe.
  //
  // The advertised `resource` MUST be the canonical APP_URL-derived per-org URI
  // (`getMcpOrgResourceUri(:org)`), NOT the request origin: it is the exact
  // string the client echoes back as the RFC 8707 `resource` at the token
  // endpoint, where it must match the AS `validAudiences` (also APP_URL-derived)
  // and the resource-server audience check. Behind a reverse proxy where the
  // public origin differs from an internal request host, an origin-derived value
  // would silently break audience binding. Doc URLs derive from the same
  // APP_URL base so discovery stays consistent.
  //
  // `authorization_servers` MUST be the AS *issuer identifier*, not the bare
  // origin. Better Auth mounts the OAuth AS at `basePath: "/api/auth"` (see
  // `packages/db/src/auth.ts`), so every metadata document it serves
  // (`/.well-known/oauth-authorization-server`, `/api/auth/.well-known/openid-
  // configuration`) advertises `issuer = APP_URL/api/auth`. RFC 8414 §3.3
  // requires the `issuer` a client reads back to be byte-identical to the AS
  // identifier it started from; advertising the bare origin here made strict
  // clients (the claude.ai connector) reject discovery on issuer mismatch and
  // fail the whole OAuth handshake. Point at the real issuer.
  app.get(PRM_PATH, (c: Context<AppEnv>) => {
    const org = c.req.param("org");
    // The route only matches with an `:org` segment present, but Hono types the
    // param as optional — guard so the resource URI is never built from a
    // non-canonical id (and a malformed segment never resolves to a resource).
    if (!isCanonicalOrgId(org)) throw notFound("Organization not found");
    const appBase = getEnv().APP_URL.replace(/\/+$/, "");
    return c.json({
      resource: getMcpOrgResourceUri(org),
      authorization_servers: [`${appBase}/api/auth`],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${appBase}/api/docs`,
    });
  });

  // RFC 9728 §5.1 challenge: on a 401 (no/invalid token) or 403 (insufficient
  // scope) the generic responder attaches this so a spec-compliant client
  // (Claude Code, …) discovers the PRM URL and starts/steps-up an OAuth flow.
  // Registered for the per-org PREFIX so it fires on every org's endpoint; the
  // `resource_metadata` URL is derived from the ACTUAL request path so it points
  // at the requested org's well-known (the challenge builder receives the
  // request origin, but the per-org PRM path is recovered from `c.req.path` via
  // the registry's path-prefix match — we rebuild it from the request path
  // captured by the responder). Anchored on the canonical APP_URL base for the
  // same proxy-safety reason as the PRM `resource` above.
  registerAuthChallenge(MCP_PREFIX, ({ status, path }) => {
    const appBase = getEnv().APP_URL.replace(/\/+$/, "");
    // `path` is the requested resource path (e.g. `/api/mcp/o/<orgId>`); the
    // per-org PRM lives at the path-insertion well-known for THAT path, so the
    // tokenless client discovers the right org's metadata and requests a token
    // bound to the right org.
    const resourceMetadata = `${appBase}${PRM_PATH_PREFIX}${path}`;
    const base = `Bearer resource_metadata="${resourceMetadata}", scope="${MCP_SCOPES.join(" ")}"`;
    // 403 here means the caller authenticated but lacks an mcp scope — signal
    // step-up per RFC 6750 §3.1 so the client requests the missing scope.
    return status === 403 ? `${base}, error="insufficient_scope"` : base;
  });

  // Rate-limit before the permission check so repeated probing (including by a
  // caller that will 403) is bounded too. Auth + audience binding run earlier
  // in the global pipeline, so the identity is already resolved here and an
  // audience-mismatched token was already rejected. Applied to the per-org
  // POST path.
  app.use(MCP_PATH, rateLimitMcp(MCP_RATE_LIMIT_PER_MIN));
  app.use(MCP_PATH, requireModulePermission("mcp", "read"));

  app.post(MCP_PATH, async (c) => {
    // Org guard. By here the global pipeline has resolved the caller's org into
    // `c.get("orgId")`: for a Bearer caller it was pinned from the token's
    // per-org audience (and the audience check already rejected a token for a
    // different org on this path); for an API-key/session caller it comes from
    // the key / X-Org-Id, NOT the URL. Require the resolved org to equal the
    // `:org` path param so an API-key caller cannot reach a DIFFERENT org's
    // endpoint than the one its key authorises, and as defence in depth for
    // Bearer. Org membership itself was already enforced by org-context.
    const org = c.req.param("org");
    if (!isCanonicalOrgId(org)) throw notFound("Organization not found");
    if (c.get("orgId") !== org) {
      throw forbidden("This MCP endpoint serves a different organization than your credentials.");
    }

    const reqUrl = new URL(c.req.url);
    const origin = reqUrl.origin;
    // A consumer that injects the get_me payload (`/api/me/context`) into its
    // own system prompt tags the session `?context=injected` so the redundant
    // get_me tool — and its "call get_me first" instruction — are dropped. Only
    // the in-process chat sets it; external MCP clients omit it and keep get_me.
    const contextInjected = reqUrl.searchParams.get("context") === "injected";
    const permissions = c.get("permissions") ?? new Set<string>();
    const authHeaders = forwardAuthHeaders(c.req.raw.headers);
    const dispatch: Dispatch = dispatchInProcess;

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

    // The disclosure tools are tenant-agnostic — the caller's org is fixed by
    // the endpoint + token audience and pinned by the org-context middleware,
    // and every in-process dispatch re-derives it the same way, so the tools
    // need no actor context. get_me likewise carries no actor context: it
    // dispatches in-process to /api/me/context, which resolves the caller from
    // the forwarded auth headers. The index is scoped to the caller's role.
    const tools = buildMcpTools({
      origin,
      permissions,
      authHeaders,
      dispatch,
      observe,
      contextInjected,
    });
    const server = createMcpServer(
      tools,
      { name: "appstrate", version: MCP_SERVER_VERSION },
      { instructions: buildServerInstructions(permissions, contextInjected) },
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Disabled deliberately: the SDK's Host-header allowlist would reject
      // legitimate reverse-proxied hosts, and the rebinding threat it guards
      // (a browser tricked into POSTing to a localhost MCP server) doesn't
      // apply here — `/api/mcp/o/:org` requires platform auth (Bearer/API key,
      // or a SameSite session cookie), so a cross-site page cannot drive it.
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
