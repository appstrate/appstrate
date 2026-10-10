// SPDX-License-Identifier: Apache-2.0

/**
 * `/api/mcp/o/:org` — the platform's inbound MCP server, exposed ONCE PER
 * ORGANIZATION (Streamable HTTP, stateless), and `/api/mcp/o/:org/s/:space`,
 * the same server pinned to one space. `:org` is the organization id (uuid).
 *
 * There is no bare `/api/mcp` endpoint: a token is RFC 8707 audience-bound to
 * ONE canonical resource URI — the org's (`${APP_URL}/api/mcp/o/<orgId>`) or a
 * space's (`…/o/<orgId>/s/<spaceId>`) — so it is confined to that organization
 * or space — least privilege by construction. A space endpoint also accepts
 * its org's token. Multi-org access means several MCP server entries
 * client-side, each with its own token.
 *
 * Mounted under `/api`, so the platform auth pipeline runs first: the caller is
 * authenticated (session cookie, API key, or OIDC Bearer), the audience check
 * confirms a Bearer token is bound to THIS endpoint's resource, and the org-context
 * middleware membership-checks and pins the org — all before any tool runs. An
 * unauthenticated request is rejected with the standard platform 401.
 * `requireModulePermission("mcp", "read")` then gates access, and an org guard
 * asserts the resolved org equals `:org` (defence in depth, and the
 * authoritative check for API-key callers whose org comes from the key, not the
 * token audience). Tool invocation re-enters the platform in-process
 * (`app.fetch`) with the caller's auth forwarded — see ./tools.ts.
 *
 * Also serves RFC 9728 Protected Resource Metadata PER ENDPOINT so spec-compliant
 * MCP clients can discover this instance's authorization server, and registers
 * a `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` challenge
 * (RFC 9728 §5.1) emitted on the 401 (no/invalid token) and the 403
 * (insufficient scope) via the generic auth-challenge registry — the trigger
 * that lets a tokenless client start the OAuth flow against the right resource.
 */

import { authorizeBundlePackages, holdsPackageShareAuthority } from "../../lib/package-access.ts";
import type { Bundle } from "@appstrate/afps-runtime/bundle";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
// `createInsufficientScopeError` marks the error it returns in a module-level
// WeakSet, and `createResourceServerChallenge` recognises it by asking
// `isInsufficientScopeError` — which it imports from `better-auth/oauth2`. The
// two must therefore come from the SAME `@better-auth/core` instance, or the
// marker lookup misses and the challenge is silently dropped (a 403 with no
// `WWW-Authenticate`, so no OAuth step-up for the client).
//
// `@better-auth/core` carries real peers (`jose`, `better-call`, `kysely`, …),
// so a peer skew — `apps/api` on one `jose` range, better-auth's transitive
// `jose` pinned to another — makes the package manager materialise two peer
// instances of the same version, and which one `better-auth` links to is
// install-order dependent. Importing through the `better-auth/*` façade (as
// `APIError` below already does) pins us to the instance the provider itself
// uses, whatever the peer graph looks like. Never reach for
// `@better-auth/core/oauth2` here.
import { createInsufficientScopeError } from "better-auth/oauth2";
import { APIError } from "better-auth/api";
import {
  createMcpServer,
  parseMcpPost,
  serveStatelessPost,
  type McpPost,
} from "@appstrate/mcp-transport";
import { OPERATION_INDEX_HEADING } from "@appstrate/core/chat-contract";
import { RUN_AND_WAIT_RESUME_INSTRUCTION } from "@appstrate/core/run-and-wait-client";
import { requireModulePermission } from "@appstrate/core/permissions";
import { forbidden, invalidRequest, methodNotAllowed, notFound } from "../../lib/errors.ts";
import { getActor } from "../../lib/actor.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { enterSpaceById } from "../../middleware/space-context.ts";
import { rateLimitMcp } from "../../middleware/rate-limit.ts";
import { logger } from "../../lib/logger.ts";
import { getPublicAppOrigin } from "../../lib/public-url.ts";
import { registerAuthChallenge } from "../../lib/auth-challenges.ts";
import { registerProtectedResourceFamily } from "../../lib/protected-resources.ts";
import { recordAuditFromContext, trackAudit } from "../../services/audit.ts";
import type { AppEnv } from "../../types/index.ts";
import { dispatchInProcess } from "../../lib/platform-app.ts";
import {
  MCP_RESOURCE_PREFIX,
  deriveMcpResourceUri,
  enclosingMcpResourceUris,
  getMcpOrgResourceUri,
  getMcpSpaceResourceUri,
  parseMcpResourceUri,
} from "../../lib/audiences.ts";
import { SPACE_ID_RE } from "@appstrate/db/ids";
import { ensureMcpResourceMintable } from "./oauth-resources.ts";
import {
  buildMcpTools,
  buildFileResourceProvider,
  deriveMcpSurface,
  FORWARDED_AUTH_HEADERS,
  RUN_AND_WAIT_LONG_POLL_RESUME,
  WARNING_CODES_PHRASE,
  type Dispatch,
  type McpObserver,
  type McpSurface,
} from "./tools.ts";
import { buildOperationIndex, buildOrgWideOperationIndex, operationIdGranted } from "./catalog.ts";
import { skillReaderFor } from "./skill-tools.ts";
import {
  listReachableSpaces,
  pinnedSpaceIds,
  requestedSpaceId,
  NO_FALLBACK_HINT,
  type McpSpace,
  type OrgWideSpaces,
} from "./spaces.ts";
import { toSpaceRoleWire } from "../../lib/space-role.ts";

const MCP_SERVER_VERSION = "1.0.0";
/** The per-org POST endpoint, parameterised on the org id. */
const MCP_PATH = `${MCP_RESOURCE_PREFIX}/:org`;
/**
 * The endpoint pinned to one space — the only client-side pin. Its own OAuth
 * resource (`getMcpSpaceResourceUri`), which also accepts the org's token.
 */
const MCP_SPACE_PATH = `${MCP_PATH}/s/:space`;
/**
 * RFC 9728 §3.1 path-insertion well-known for each resource: the metadata URL
 * is built by inserting the well-known segment BEFORE the resource's path, so a
 * strict client probes `…/oauth-protected-resource` + `/api/mcp/o/:org` (or
 * `…/s/:space`). There is no bare well-known (no single generic resource).
 */
const PRM_PATH_PREFIX = "/.well-known/oauth-protected-resource";
const PRM_PATH = `${PRM_PATH_PREFIX}${MCP_PATH}`;
const PRM_SPACE_PATH = `${PRM_PATH_PREFIX}${MCP_SPACE_PATH}`;
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
export function buildServerInstructions(
  permissions: ReadonlySet<string>,
  ceiling: ReadonlySet<string> | undefined,
  surface: McpSurface,
  contextInjected = false,
  orgSpaces?: OrgWideSpaces,
): string {
  // A missing act is taught by ABSENCE (see `McpSurface`).
  const { invokes, runs, composes: inline, authors, importsPackages } = surface;
  // A sentence naming an operation renders only for a caller its route grants,
  // unless the gate it sits under already implies that grant (org-wide: in any space).
  const granted = (operationId: string): boolean =>
    orgSpaces
      ? orgSpaces.reachable.some((s) => operationIdGranted(operationId, s.permissions, ceiling))
      : operationIdGranted(operationId, permissions, ceiling);
  const listsIntegrations = invokes && granted("listIntegrations");
  const connects = runs && granted("initiateIntegrationConnect");
  const runningAgents = runs ? "configuring or running" : "configuring";
  const agentUse = authors ? "building or configuring" : runningAgents;
  // A `contextInjected` caller (the chat module) already injects the get_me
  // payload into its own system prompt and we drop the get_me tool for it, so
  // pushing "call get_me first" would point the model at a tool that isn't
  // there. Tell it the context is already provided instead.
  const grounding = contextInjected
    ? `Your caller context — who you are acting for, your role in this organization, and which integrations are already connected (prefer those when ${agentUse} an agent) — is already provided to you; there is no get_me tool, do not look for one.`
    : `Start by calling get_me to learn who you are acting for, your role in this organization, and which integrations are already connected (prefer those when ${agentUse} an agent).`;
  // Both halves of the connect bullet below end the same way: the connect offer
  // is already in the tool result, and only its DELIVERY differs by client. The
  // chat renders the offer as a card itself, so the model must not restate it;
  // an external MCP client has no card, so the model hands the URL over. One
  // string, emitted once, so the two branches cannot drift apart.
  const connectDelivery = contextInjected
    ? "The client renders the connect button from this result on its own; your text must NOT duplicate it — do NOT paste the link, do not describe the button or where to click. End your turn with ONE short sentence saying you'll continue once the integration is connected — do NOT poll, loop, wait, or run in the same turn."
    : "Give the caller that `connect_url` to open, in one short sentence, and end your turn — do NOT poll, loop, wait, or run in the same turn.";
  // Every inline-run span below follows `run_and_wait`'s own descriptor: a
  // caller who cannot compose is not told about a kind the route refuses.
  const runOps = inline ? "`runAgent`/`runInline`" : "`runAgent`";
  // Discovery-only (`mcp:read` alone): the operationId goes no further than describe.
  const verbs = invokes ? "discover and call" : "discover and inspect";
  const pickOperation = invokes
    ? "then call describe_operation for its input schema and invoke_operation to run it"
    : "then call describe_operation for what it does and the shape of its input";
  const packageImportGuidance = importsPackages
    ? " Call `import_package_file` only when validation returns BOTH `valid: true` AND `importable: true`, and the user asked to add the package. If conflicts make it non-importable, report them instead of attempting a doomed mutation."
    : "";
  const inlineShortcut = inline
    ? " For an inline run, pass a PARTIAL canonical AFPS `manifest`: normally set a concise task-specific `display_name` plus the dependencies/configuration needed for the task. The platform derives `name` and defaults omitted boilerplate, `runtime_tools` (log, output, publish_file), and an open object output schema. Every provided field replaces its default exactly; arrays and nested objects are never merged, so `runtime_tools: []` stays empty. You may override every field with a complete deterministic manifest; a strict `output.schema` requires an explicit runtime tool selection containing `output`. The chat shows ONLY lines the run emits via `log`, so instruct it in the top-level `prompt` to log meaningful steps whenever that tool is selected."
    : "";
  // Authoring a package means an inline run writing it; without that grant
  // only the validation half of the bullet is true.
  const packageFiles = inline
    ? "MCP package authoring — call `get_runtime_capabilities` first, have one inline run create the manifest + executable files, package them from the package root with the available shell tools (for example `python3 -m zipfile -c package.afps manifest.json <entry-point> ...`), then publish that archive with `publish_file` and pass the returned `appfile://` URI to `validate_package_file`."
    : "MCP package files — to check an existing archive, pass its `appfile://` URI to `validate_package_file`.";
  // Both need `invoke_operation`; the integration preference order they sit
  // beside names no tool, so every caller gets it.
  const concurrencyBullet = invokes
    ? `- Writes are read-then-write — a versioned resource's result carries \`etag\`; send it back verbatim as \`if_match\` on the next write to it. Package draft updates (\`updateAgent\`, \`updateSkill\`, …) REQUIRE it (428 without): read the package first, then write with its \`etag\`, and use the \`etag\` of each write's result for the next one. A 412 means it changed in between: re-read, reapply your change, retry.
`
    : "";
  const heavyListBullet = invokes
    ? `- Heavy list responses — list operations paginate with \`query: { limit, offset }\`, and some${listsIntegrations ? " (e.g. `listIntegrations`)" : ""} also take a \`fields\` selector (comma-separated projection; describe_operation shows it when available). On heavy lists request only the fields you need${listsIntegrations ? ' — e.g. `fields: "id,active,block_user_connections"` on `listIntegrations` —' : ""} and read a single row's detail operation when you need its full \`manifest\`.
`
    : "";
  const integrationListing = listsIntegrations
    ? ` \`GET /api/integrations\` lists every integration with an \`active\` flag (activated for this space) and \`block_user_connections\`; use it to tell tiers 2 and 3 apart. Do not silently activate or connect an integration the caller did not ask for — surface that it would be needed and let them decide.`
    : "";
  // Everything about launching a run — intro sentences, run bullets, readiness
  // and connect guidance — is absent together for a caller who cannot launch.
  const runIntro = runs
    ? ` When you need a newly launched run's progress or result, prefer the run_and_wait tool directly; it already owns launch plus waiting and declares its own schema. For intentionally fire-and-forget runs, use ${runOps} through describe_operation and invoke_operation.`
    : "";
  // A `done:false` run is still going. An external client waits on it; the chat
  // gets `done:false` at the end of its turn budget, too late for a long-poll.
  const doneFalseFollowUp = contextInjected
    ? RUN_AND_WAIT_RESUME_INSTRUCTION
    : RUN_AND_WAIT_LONG_POLL_RESUME;
  const runBullets = runs
    ? `- Runs are asynchronous: triggering one returns the created run resource (use its \`id\`), then it moves pending→running→success|failed|timeout|cancelled. When you need the result of a run you are launching now, prefer \`run_and_wait\` over manually composing ${runOps} plus \`getRun\`; it handles launch and waiting in one call. Use \`getRun\` with \`query: { wait: true }\` when you are inspecting or waiting on an existing run that \`run_and_wait\` did not launch in this turn; for a run \`run_and_wait\` returned with \`done:false\`, see the shortcut below.
- Shortcut — \`run_and_wait\` launches a run, exposes the created run to chat for live progress, then waits internally and returns \`{ id, packageId, status, done:true, result?, error?, warnings }\` once the run is terminal (\`error\`: the run's own failure; \`warnings\`: see the connect bullet). Prefer it for launch-and-wait flows; use the fully discoverable ${runOps} when you deliberately want to launch without waiting. \`done:true\` means the run is over: do not call \`getRun\` to wait for it. \`done:false\` means its wait ended first. ${doneFalseFollowUp}${inlineShortcut}
`
    : "";
  const authKeySource = listsIntegrations
    ? "<the error's auth_key, or a key from manifest.auths of the integration row from GET /api/integrations when the error carries none>"
    : "<the error's auth_key>";
  const connectFlow = connects
    ? ` When it does NOT (except \`insufficient_scopes\`, below), you MUST start the connect flow yourself (do not just describe it): CALL \`invoke_operation\` with \`operation_id: "initiateIntegrationConnect"\`, \`path_params: { packageId: "<id>", authKey: "${authKeySource}" }\` and \`body: { scopes: <the error's required_scopes, verbatim, when it carries them>, connection_id: <the error's connection_id, for a needs_reconnection item only — the existing connection is then reconnected in place instead of duplicated, with no scopes> }\`. Forwarding \`required_scopes\` is what makes the consent cover the scopes the run needs instead of re-granting the same insufficient set. This op is auth-type-agnostic — it works for every auth (oauth2, api_key, basic, mtls, custom), so you never inspect the auth type yourself — and its result is what carries the \`connect_url\`; without that call there is none, so never promise a connect link you did not just obtain this turn.`
    : "";
  const pins = granted("upsertMyIntegrationPin");
  // #1871: no link for it — an upgrade in place widens every agent using the connection. A launch
  // override beats a member pin and a soft default, and works for inline runs too.
  const stick = pins ? " For a stored agent, `upsertMyIntegrationPin` makes it stick." : "";
  const newId = granted("listIntegrationConnections")
    ? " Once the user finished the link, its id is the newest connection of that integration and account in `listIntegrationConnections`."
    : " Once the user finished the link, retrying without overrides works only when `source` is `fallback_auto` (the fallback picks a connection of the same account); for a `member_pin` or `org_default`, the new connection must be named in a pin or an override.";
  const insufficientScopes = connects
    ? ` An \`insufficient_scopes\` item carries no \`connect_url\`. When its \`source\` is \`admin_pin\`, \`org_default_enforced\` or \`schedule_override\`, create nothing: tell the user an admin (or the schedule's owner) must switch that binding. Otherwise create a NEW connection (as above, WITHOUT \`connection_id\`, \`scopes\` = its \`required_scopes\`) and retry with \`connection_overrides\` naming it.${newId}${stick} Pass \`connection_id\` instead, upgrading the connection in place, only when \`owned_by_actor\` is true and the user explicitly chose it after you told them it widens every agent using that connection.`
    : ` An \`insufficient_scopes\` item carries no \`connect_url\`: tell the user to create a connection with its \`required_scopes\` (or have the existing one upgraded) in Appstrate and bind it to this run.`;
  const pinChoice = pins
    ? ` For a stored agent, a member pin makes the choice stick for its later runs: \`upsertMyIntegrationPin\` (path: the agent id and the integration id; body \`{ connection_ids: [...] }\`).`
    : "";
  // This server's `run_and_wait` strips the link from a started run's warnings for every caller
  // (tools.ts); only the chat's own launcher keeps it, for the connect card it renders.
  const warningConnect = contextInjected
    ? "; the chat client renders a connect button under the run itself when connecting would help). Report the result as lacking that integration and offer to connect it when that button appears — do NOT paste or promise a link"
    : `; a warning here never carries a \`connect_url\`). Report the result as lacking that integration and offer to connect it when the warning carries a connect target — ${connects ? "when the caller asks, start it with `initiateIntegrationConnect` from the warning's `auth_key` and `required_scopes`, as for an error item below" : "connecting it is for the user to do"}`;
  const connectBullets = runs
    ? `
- Connecting or reconnecting an integration before a run — an integration may be unconnected, expired, needs-reconnection, under-scoped, or otherwise unusable. Do NOT pre-validate just to launch a "do it now" ${inline ? "inline run" : "run"}: \`run_and_wait\` already runs the same readiness preflight and returns a 409 \`missing_integration_connection\` without consuming credits when the ${inline ? "manifest" : "agent"} cannot run. A declared integration blocks the launch only when the ${inline ? "manifest" : "agent"} marks it \`required\` or what is bound is broken or ambiguous: an optional one with no usable connection, bound to none on purpose (\`[]\`), or inactive in the space lets the run start without it, and the result's \`warnings\` names it with the code that state would raise as an error (${WARNING_CODES_PHRASE}; \`integration_unbound\` alone: a pin or override chose \`[]\`), same \`field\` and fields as an error item; \`auth_key\` and \`required_scopes\` only when connecting would help${warningConnect}; do not start a connect flow or re-run unless the caller asks. A schedule write answers \`warnings: null\` when it judged nothing (disabled, no resolution-affecting change, or written for another member, whose connections it never reveals) and \`[]\` only when it judged and found nothing to report. If \`run_and_wait\` fails with field errors whose \`field\` is \`integrations.<id>\`${inline ? " (or if you intentionally call `validateInlineRun` only to iterate/check readiness without launching)" : ""}, that integration is not ready — whatever the \`code\` (\`not_connected\`, \`needs_reconnection\`, \`insufficient_scopes\`, \`auth_key_mismatch\`, …), with ONE exception below. Handle each such error item by looking ${connects ? "FIRST " : ""}for a \`connect_url\` on the item. When it HAS one, the connect session is already minted and this tool result already carries it: do NOT call ${connects ? "`initiateIntegrationConnect`, do NOT call any other tool" : "any tool"}, do not restate the connection request.${connectFlow} ${connectDelivery}${insufficientScopes} On a later turn, call \`run_and_wait\` again${inline ? " (or `validateInlineRun` if you are only checking readiness)" : ""}; when readiness passes, proceed with the run.
- The exception — code \`must_choose_connection\` on \`integrations.<id>\` is NOT a connect problem: the platform will not pick the connection itself — the user holds several, or only connections other members share, which are never used without an explicit choice — and needs you to say which one to use. Do NOT start a connect flow for it (another connection makes the ambiguity worse). Retry the SAME \`run_and_wait\` call with the top-level \`connection_overrides\` argument, mapping that integration id to the candidates' \`id\`s: \`connection_overrides: { "<id>": ["<candidate_connection_id>", ...] }\`. Always an ARRAY — a bare id is refused before the launch. The key is the integration id itself — not the error's \`field\` path. The error's \`candidate_connections\` carry a \`label\`, an \`account_id\`, \`owned_by_actor\` and \`needs_reconnection\`: read those to choose — if the user named an account, match it there rather than listing connections in a separate call. Never pick a candidate whose \`needs_reconnection\` is true (the run fails on it); if it is the one the task needs, tell the user to reconnect it. A candidate with \`owned_by_actor: false\` is another member's shared account, so that choice visibly matters: use it only when the user named it, otherwise ask. Name several only when the task genuinely needs them all (the run's tools then take a required \`connection\` argument); otherwise pick one candidate yourself when nothing distinguishes them, and ask the user only if the choice visibly matters.${pinChoice}
- Code \`auth_serves_no_selected_tool\` on \`integrations.<id>\` is not a connect problem either: the connection its \`connection_id\` names was explicitly bound (your \`connection_overrides\`, or a pin or default) and was made on an auth that exposes none of the agent's selected tools, so reconnecting it changes nothing. When you passed \`connection_overrides\`, retry without that id; when a pin or default binds it, tell the user which connection to take out of the set.
- Code \`auth_key_serves_no_selected_tool\` on \`integrations.<id>\` is not a connection problem at all: the agent's own \`auth_key\` (its \`required_auth_key\`) names an auth that exposes none of the agent's selected tools, so no connection, pick or override can clear it. Do not start a connect flow. ${inline ? "For an inline run you wrote that configuration: fix `auth_key` or `tools` for that integration in your manifest and retry; for a stored agent, do not retry — tell" : "Do not retry — tell"} the user the agent's configuration must change (its \`auth_key\` for that integration, or its tool selection).
- Code \`required_integration_unbound\` on \`integrations.<id>\` is not a connect problem: the agent requires that integration and a pin, or a stored schedule's \`connection_overrides\`, binds it to none (\`[]\`). It clears by naming a connection in that layer, or in \`connection_overrides\` (a run override outranks a member pin, not an admin pin); tell the user which. In \`connection_overrides\`, \`[]\` runs without the integration and is refused (400) for a required one.`
    : "";
  return `Appstrate runs autonomous AI agents in sandboxed Docker containers. The tools here let you ${verbs} any operation of the Appstrate REST API — their own descriptions tell you how. ${grounding} The operation index at the end of these instructions lists the operations available to your role by tag; it is your primary way to find an operation. Default to picking an operationId straight from that index, ${pickOperation}. Reach for search_operations only when the index is genuinely ambiguous or a capability you expect isn't listed — not as a routine first step. Never guess an operationId or body shape: describe_operation (or search_operations' best_match) is the source of truth for the input schema.${runIntro}

## Core model
Organization → Spaces (id \`spc_…\`, one default) → Agents → Runs. End-users (\`eu_…\`) are external identities for embedded use. Packages (agents, integrations, skills…) are identified as \`@scope/name\` (e.g. \`@appstrate/my-agent\`). Depending on the operation this is passed either as a single \`packageId\` param or split into separate \`scope\` and \`name\` params — describe_operation shows which; always keep the \`@\`, and the \`/\` when it's a single param.

## Org & space context
${orgSpaces ? orgWideSpaceContext : pinnedSpaceContext}

## Beyond the per-operation schemas
${runBullets}- ${packageFiles}${packageImportGuidance} Archive bytes stay server-side throughout.
- Streaming/SSE operations (live logs, realtime) cannot be called through this server; fetch logs or poll instead.
- Wire JSON is snake_case, except universal id/timestamp fields (id, createdAt…) which stay camelCase.
- A refused call is a tool result with \`isError: true\` and \`{ code, error, … }\`. \`missing_argument\`, \`unknown_argument\`, \`invalid_argument\`, \`unknown_operation\`, \`unknown_space\` and \`space_mismatch\` mean fix the call (\`arguments\` names the faulty ones, \`accepted\` lists what is valid) and retry. \`not_granted\` (a permission, or a file you may see but not download) is final: report it. An operation the route answered with an HTTP error is not a refusal: it comes back as \`{ status, body }\` with \`isError: true\`; read \`body\` to decide — except a \`403\` your permissions explain, which is a \`not_granted\` refusal.
${heavyListBullet}${concurrencyBullet}${
    authors
      ? `- Integration tool selection — an agent's \`integrations_configuration[id].tools\` resolves as: omitted/undefined → inherits the integration's \`default_tools\`; \`[]\` → no tools (overrides the default); \`["a","b"]\` → exactly those tools; \`"*"\` → all upstream tools (requires \`allow_undeclared_tools\`). A declared integration whose selection resolves to NOTHING is rejected at publish and at import (\`no_tools_selected\` on \`integrations_configuration.<id>.tools\`) and aborts the run at container boot — so never leave an integration declared with an empty effective selection: either select at least one tool, or remove it from \`dependencies.integrations\`. A declared integration is optional unless \`integrations_configuration[id].required\` is \`true\`: without a usable connection an optional one is reported in the run's \`warnings\` and the run starts anyway; a required one refuses the launch. Mark \`required\` only what the agent cannot work without.${
          granted("getIntegration")
            ? " An integration's `default_tools` and full `tool_catalog` are on its detail operation (`GET /api/integrations/{packageId}`); read it before selecting tools so you pick real tool names and know what the default already covers."
            : ""
        }
`
      : ""
  }- Integration preference — when a task needs an integration, prefer in order: (1) one the caller has already connected (listed in your caller context / get_me — connecting it was an explicit choice), then (2) one that is activated for this space but not yet connected, then (3) one that is neither.${integrationListing}${connectBullets}

${OPERATION_INDEX_HEADING}
${orgSpaces ? buildOrgWideOperationIndex(orgSpaces.reachable, ceiling) : buildOperationIndex(permissions, ceiling)}`;
}

const pinnedSpaceContext =
  "This MCP server is scoped to ONE organization — the one this endpoint serves — and to the one space this connection is pinned to; every operation runs there and you never send those ids per call. To act in another organization, connect that organization's own MCP server (its URL carries its id).";

const orgWideSpaceContext = `This MCP server is scoped to ONE organization — the one this endpoint serves — and reaches every space of it where you hold a role. To act in another organization, connect that organization's own MCP server (its URL carries its id).
- Every tool that acts in a space REQUIRES \`space_id\`, reads and writes alike: there is no default space. The argument's schema lists your spaces, their ids and your role in each. Pick the space from the user's request; when it is ambiguous, ask.
- Your role differs per space, so an operation allowed in one may be refused in another. A refusal is final for that task: ${NO_FALLBACK_HINT}
- Space names are not unique: every machine field — \`space_id\`, \`granted_in\`, the index's \`[…]\` — names a space by id.`;

function forwardAuthHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_AUTH_HEADERS) {
    const value = src.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** Set by the space-entry middleware: the parsed body and, org-wide, the spaces. */
type McpEnv = AppEnv & { Variables: { mcpPost?: McpPost | null; mcpOrgSpaces?: OrgWideSpaces } };

/** A tool or act is offered when one reachable space grants it; the guard decides each call. */
function unionSurface(spaces: readonly McpSpace[]): McpSurface {
  const any = (key: keyof McpSurface) => spaces.some((s) => s.surface[key]);
  return {
    invokes: any("invokes"),
    runs: any("runs"),
    composes: any("composes"),
    authors: any("authors"),
    listsFiles: any("listsFiles"),
    importsPackages: any("importsPackages"),
  };
}

/**
 * Injection seam for the audit sink. Production uses `recordAuditFromContext`;
 * the integration suite substitutes a sink whose insert it controls, to prove
 * the MCP response does not wait on it.
 */
export interface McpRouterDeps {
  recordAudit?: typeof recordAuditFromContext;
}

export function createMcpRouter(deps: McpRouterDeps = {}): Hono<AppEnv> {
  const recordAudit = deps.recordAudit ?? recordAuditFromContext;
  const app = new Hono<McpEnv>();

  // Register the MCP protected-resource FAMILY (RFC 8707 audience binding).
  // The concrete resources are dynamic (one URI per org and per space, created
  // at runtime) so they cannot be enumerated at registration time — the family
  // owns the whole `/api/mcp/o` sub-tree:
  //   - `deriveUri(path)` maps an endpoint path to its canonical org or space
  //     URI, and `enclosingUris` adds the org URI a space endpoint also accepts,
  //     so `enforceResourceAudience` (inbound) requires one of those in the
  //     token `aud`: a token for org A on `/api/mcp/o/B`, or for space S on the
  //     org endpoint or on another space, is a mismatch and 401s.
  //   - `ownsUri(uri)` recognises an MCP URI as protected without a request
  //     path, for outbound confinement (an MCP token may not be replayed on a
  //     non-resource route) and the AS mint-time self-service gate.
  //   - `ensureMintable(uri)` writes a live space's `oauth_resources` row when
  //     the AS is asked for it, so the provider can resolve it.
  // `ownsUri` accepts exactly the URIs `deriveUri` emits: `parseMcpResourceUri`
  // binds only a canonical org or space URI.
  registerProtectedResourceFamily({
    prefix: MCP_RESOURCE_PREFIX,
    deriveUri: deriveMcpResourceUri,
    ownsUri: (uri) => parseMcpResourceUri(uri) !== undefined,
    enclosingUris: enclosingMcpResourceUris,
    ensureMintable: ensureMcpResourceMintable,
  });

  // RFC 9728 Protected Resource Metadata, served PER ORG and PER SPACE — public
  // (outside `/api/*`). Points clients at this instance's OAuth authorization
  // server (served by the oidc module at /.well-known/oauth-authorization-server).
  //
  // Served at the path-insertion variant only
  // (`/.well-known/oauth-protected-resource/api/mcp/o/:org[/s/:space]`): RFC
  // 9728 §3.1 has a client derive the metadata URL by inserting the well-known
  // segment before the resource's path, and §3.3 requires the `resource` it
  // reads back to be the endpoint it started from. There is no bare well-known
  // — there is no single generic resource to describe.
  //
  // The advertised `resource` MUST be the canonical APP_URL-derived URI
  // (`getMcpOrgResourceUri` / `getMcpSpaceResourceUri`), NOT the request
  // origin: it is the exact string the client echoes back as the RFC 8707
  // `resource` at the token endpoint, where it must match an `oauth_resources`
  // row (also APP_URL-derived) and the resource-server audience check. Behind a reverse
  // proxy where the public origin differs from an internal request host, an
  // origin-derived value would silently break audience binding. Doc URLs derive
  // from the same APP_URL base so discovery stays consistent.
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
  const describeResource = (c: Context<AppEnv>) => {
    const org = c.req.param("org");
    // The route only matches with an `:org` segment present, but Hono types the
    // param as optional — guard so the resource URI is never built from a
    // non-canonical id (and a malformed segment never resolves to a resource).
    if (!isCanonicalOrgId(org)) throw notFound("Organization not found");
    const space = c.req.param("space");
    if (space !== undefined && !SPACE_ID_RE.test(space)) throw notFound("Space not found");
    const appBase = getPublicAppOrigin();
    return c.json({
      resource: space ? getMcpSpaceResourceUri(org, space) : getMcpOrgResourceUri(org),
      authorization_servers: [`${appBase}/api/auth`],
      scopes_supported: [...MCP_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${appBase}/api/docs`,
    });
  };
  app.get(PRM_PATH, describeResource);
  app.get(PRM_SPACE_PATH, describeResource);

  // RFC 9728 §5.1 challenge: on a 401 (no/invalid token) or 403 (insufficient
  // scope) the generic responder attaches this so a spec-compliant client
  // (Claude Code, …) discovers the PRM URL and starts/steps-up an OAuth flow.
  // Registered for the family PREFIX so it fires on every org and space
  // endpoint, while the resource is derived from the ACTUAL request path — the
  // tokenless client is pointed at the requested endpoint's well-known and gets
  // a token bound to that org or space. Anchored on the canonical APP_URL base
  // for the same proxy-safety reason as the PRM `resource` above.
  //
  // `createResourceServerChallenge` owns the serialization: it inserts the
  // well-known segment ahead of the resource path per RFC 9728 §3.1, quotes
  // every auth-param per RFC 6750, and answers a DPoP failure with the RFC 9449
  // `DPoP` challenge. The responder hands us a status, not the error the
  // pipeline raised, so each status is expressed as the error upstream keys
  // off: a bare 401 for "no or invalid token", and — because reaching this
  // prefix at all is gated on `mcp:read` — an insufficient-scope error for the
  // 403, which is the step-up signal an MCP client acts on.
  registerAuthChallenge(MCP_RESOURCE_PREFIX, ({ status, path }) => {
    const resource = deriveMcpResourceUri(path);
    if (!resource) return undefined;
    const error =
      status === 403
        ? createInsufficientScopeError(MCP_SCOPES)
        : new APIError("UNAUTHORIZED", { message: "invalid access token" });
    const challenge = createResourceServerChallenge(error, resource, {
      challengeScopes: MCP_SCOPES,
    });
    return new Headers(challenge?.headers).get("WWW-Authenticate") ?? undefined;
  });

  // Rate-limit before the permission check so repeated probing (including by a
  // caller that will 403) is bounded too. Auth + audience binding run earlier
  // in the global pipeline, so the identity is already resolved here and an
  // audience-mismatched token was already rejected. Applied to both
  // POST paths.
  for (const path of [MCP_PATH, MCP_SPACE_PATH]) {
    app.use(path, rateLimitMcp(MCP_RATE_LIMIT_PER_MIN));
  }

  // `mcp` is a SPACE-level resource, and `/api/mcp` is not in
  // `SPACE_SCOPED_PREFIXES` — this endpoint pins an org, not a space. So it
  // resolves its own space and applies the caller's role in it through the same
  // helper the middleware uses (RBAC spec §4.3), BEFORE the guard below; org
  // permissions alone can never carry `mcp:read`, so without this the guard
  // could not pass for anyone.
  //
  // The org resolved by the pipeline is the one used, never the `:org` path
  // param: the handler's own guard is what rejects a mismatch, and resolving
  // the caller's own space here leaves that answer unchanged.
  const enterSpace = async (c: Context<McpEnv>, next: () => Promise<void>) => {
    // A live REST header: ignoring it would silently widen a connection meant
    // to be confined, so it is refused, as an undeclared tool argument is.
    if (c.req.header("X-Space-Id") !== undefined) {
      throw invalidRequest(
        "X-Space-Id is not read by the MCP endpoint: pin the connection to a space with its " +
          "URL, /api/mcp/o/<org>/s/<space>, or use the organization's URL to reach every space.",
        "X-Space-Id",
      );
    }
    const orgId = c.get("orgId");
    if (!orgId) return next();
    // Hono caches the body: the handler serves this same parse.
    const post = parseMcpPost(await c.req.arrayBuffer());
    c.set("mcpPost", post);
    const pinned = pinnedSpaceIds(c);
    if (pinned.length > 0) {
      if (new Set(pinned).size > 1) {
        throw forbidden("The space in the URL is not the credential's space");
      }
      await enterSpaceById(c, pinned[0]!, orgId);
      return next();
    }
    // Org-wide: enter the space the call names; a request naming none
    // (initialize, tools/list) enters any reachable one to pass the guard.
    const ceiling = c.get("scopeCeiling");
    const actor = getActor(c);
    const reachable = (await listReachableSpaces(c, orgId)).map((space) => ({
      ...space,
      surface: deriveMcpSurface(space.permissions, ceiling, actor),
    }));
    const requested = await requestedSpaceId(post?.payload, orgId);
    const chosen = reachable.find((s) => s.id === requested) ?? reachable[0];
    if (!chosen) {
      throw forbidden("You hold no role with MCP access in any space of this organization.");
    }
    await enterSpaceById(c, chosen.id, orgId);
    // The admission's read is the one the guards apply: a role changed since
    // the listing must not leave the tools a wider surface than the routes.
    const permissions = c.get("permissions")!;
    const current = {
      ...chosen,
      role: toSpaceRoleWire(c.get("spaceRole")!)!.name,
      permissions,
      surface: deriveMcpSurface(permissions, ceiling, actor),
    };
    c.set("mcpOrgSpaces", {
      reachable: reachable.map((s) => (s.id === current.id ? current : s)),
      current,
    });
    return next();
  };
  for (const path of [MCP_PATH, MCP_SPACE_PATH]) {
    app.use(path, enterSpace);
    app.use(path, requireModulePermission("mcp", "read"));
  }

  const serveMcp = async (c: Context<McpEnv>) => {
    // Org guard. By here the global pipeline has resolved the caller's org into
    // `c.get("orgId")`: for a Bearer caller it was pinned from the token's MCP
    // audience (and the audience check already rejected a token for a
    // different org or space on this path); for an API-key/session caller it comes from
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
    const origin = getPublicAppOrigin();
    // A consumer that injects the get_me payload (`/api/me/context`) into its
    // own system prompt tags the session `?context=injected` so the redundant
    // get_me tool — and its "call get_me first" instruction — are dropped. Only
    // the in-process chat sets it; external MCP clients omit it and keep get_me.
    const contextInjected = reqUrl.searchParams.get("context") === "injected";
    // Set by the space-entry middleware mounted on this exact path; absent
    // means the chain was rewired, not that the caller holds nothing.
    const permissions = c.get("permissions");
    if (!permissions) throw new Error("mcp: permissions missing on a guarded route");
    // A delegated credential's scopes; ceiling guards refuse what they omit.
    const ceiling = c.get("scopeCeiling");
    const authHeaders = forwardAuthHeaders(c.req.raw.headers);
    const orgSpaces = c.get("mcpOrgSpaces");
    // Set by the space-entry middleware above, which runs on this exact path
    // and cannot have been skipped: the org guard just proved `orgId` is set,
    // and that is the middleware's only early return.
    const scope: SpaceScope = { orgId: org, spaceId: c.get("space")!.id };
    // Dispatched calls re-enter the space this request entered.
    authHeaders.set("x-space-id", scope.spaceId);
    const dispatch: Dispatch = dispatchInProcess;
    // The caller identity + space scope for tools that call a service directly (the
    // file resource provider). Resolved the same way the in-process
    // sub-dispatch would, so direct and dispatched paths stay consistent.
    const actor = getActor(c);

    // Audit + telemetry sink. The tool layer emits plain data; here we decide
    // what to do with it: structured telemetry for every tool call, and a
    // durable audit row for invoke_operation outcomes (the underlying route
    // self-audits its own mutation, but the MCP indirection is recorded
    // separately so the trail shows the call arrived via MCP). Reads
    // (search/describe) are metadata browsing and are not audited.
    //
    // Audit inserts are NOT awaited on the response path — every chat tool
    // call goes through here, and its two Hono passes would each pay the
    // insert's round-trip. The trail still survives a process recycle: the promise is handed
    // to `trackAudit`, and graceful shutdown (`lib/shutdown.ts`) drains the
    // registry before the DB connection closes. What is lost is only what a
    // hard kill would have lost anyway. The insert is itself best-effort and
    // never rejects (recordAudit swallows), and `recordAuditFromContext` reads
    // the context synchronously before its first await, so nothing here
    // depends on the request outliving the response (over SSE it runs after the handler returned).
    const observe: McpObserver = (event) => {
      logger.info("mcp.tool_call", {
        requestId: c.get("requestId"),
        tool: event.tool,
        durationMs: Math.round(event.durationMs),
        operationId: event.operationId,
        method: event.method,
        path: event.path,
        status: event.status,
        runStatus: event.runStatus,
        outcome: event.outcome,
        shownCount: event.shownCount,
        deniedCount: event.deniedCount,
        spaceId: scope.spaceId,
      });
      if (event.tool === "invoke_operation" && event.outcome === "invoked") {
        // `void`: deliberately off the response path — the rationale, and what
        // drains these before the process exits, is the comment above.
        void trackAudit(
          recordAudit(c, {
            action: "mcp.operation.invoked",
            resourceType: "mcp_operation",
            resourceId: event.operationId ?? null,
            after: {
              method: event.method ?? null,
              path: event.path ?? null,
              status: event.status ?? null,
              outcome: event.outcome,
              spaceId: scope.spaceId,
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
    const toolCtx = {
      authorizeBundle: (bundle: Bundle) => authorizeBundlePackages(c, bundle),
      mayShareRoot: (packageId: string) => holdsPackageShareAuthority(c, packageId),
      readSkill: skillReaderFor(c, scope),
      requestId: c.get("requestId"),
      origin,
      permissions,
      ceiling,
      authHeaders,
      dispatch,
      observe,
      contextInjected,
      actor,
      scope,
      orgSpaces,
    };
    const surface = orgSpaces
      ? unionSurface(orgSpaces.reachable)
      : deriveMcpSurface(permissions, ceiling, actor);
    const tools = buildMcpTools(toolCtx, surface);
    // `resources/read` for `appfile://file_xxx` — resolves through the same
    // forwarded-auth in-process dispatch as the tools (files are NOT listed
    // under `resources/list`; they surface only via `resource_link`).
    const resources = buildFileResourceProvider(toolCtx);
    const server = createMcpServer(
      tools,
      { name: "appstrate", version: MCP_SERVER_VERSION },
      {
        instructions: buildServerInstructions(
          permissions,
          ceiling,
          surface,
          contextInjected,
          orgSpaces,
        ),
        resources,
      },
    );
    const raw = c.req.raw;
    const body = await c.req.arrayBuffer();
    // `null`: the SDK reads the bytes itself and answers its own parse error.
    const post = c.get("mcpPost") ?? null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !post?.requestsProgress,
      // Disabled deliberately: the SDK's Host-header allowlist would reject
      // legitimate reverse-proxied hosts, and the rebinding threat it guards
      // (a browser tricked into POSTing to a localhost MCP server) doesn't
      // apply here — `/api/mcp/o/:org` requires platform auth (Bearer/API key,
      // or a SameSite session cookie), so a cross-site page cannot drive it.
      enableDnsRebindingProtection: false,
    });

    // The SDK reads these bytes only when they did not parse here.
    const forwarded = new Request(raw.url, { method: raw.method, headers: raw.headers, body });

    // Any audit insert the tool layer triggered is already tracked (see
    // `observe` above) and flushed at shutdown, not here.
    return serveStatelessPost(server, transport, forwarded, post);
  };
  app.post(MCP_PATH, serveMcp);
  app.post(MCP_SPACE_PATH, serveMcp);

  // The stateless transport serves no standalone server→client SSE stream
  // (GET) and has no session to terminate (DELETE), so POST is the only
  // meaningful verb. Reject everything else with 405 + `Allow: POST` rather
  // than letting the SDK open a dangling GET SSE stream that never receives a
  // message. Auth still runs first (global pipeline), so an unauthenticated
  // request of any verb is rejected with 401 before reaching here.
  const notAllowed = () => {
    throw methodNotAllowed(["POST"]);
  };
  app.all(MCP_PATH, notAllowed);
  app.all(MCP_SPACE_PATH, notAllowed);

  return app;
}
