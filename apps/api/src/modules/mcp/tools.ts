// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP tool surface: a compact progressive-disclosure and workflow layer.
 *
 * The platform exposes ~250 operations. Surfacing them as 250 individual
 * MCP tools would blow past every client's tool-definition budget (50 tools
 * ≈ 72K tokens), so instead we expose a tiny fixed surface and let the model
 * discover on demand:
 *
 *   - `search`              — keyword search over every kind the caller acts on
 *                             (operations, integration tools, agents, skills)
 *   - `describe`            — everything needed to act on one item
 *   - `invoke_operation`    — execute one operation
 *
 * A root tool exists only when it does what `invoke_operation` cannot: relay a
 * third-party tool result (`call_integration_tool`), launch and wait
 * (`run_and_wait`), read bytes (`read`), import a package archive. Discovery is
 * one tool for every kind, description one tool for every kind.
 *
 * `invoke_operation` dispatches **in-process** through the platform's own
 * Hono app (`app.fetch`), re-entering the full auth pipeline + RBAC. The
 * caller's auth context is forwarded verbatim, so an MCP call can never
 * exceed what the same credential could do over REST. `mcp:invoke` gates the
 * tool; the underlying operation still enforces its own permission.
 *
 * The caller's tenant is fixed by the endpoint, not chosen at runtime: the MCP
 * server is exposed per organization (`/api/mcp/o/:org`) and the bearer token
 * is RFC 8707 audience-bound to that one org, so there is no org-switching tool
 * — the org comes from the URL/token, and the org-context middleware pins it.
 */

import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  notifyDetached,
  RESOURCE_BLOB_MAX_BYTES,
  RESOURCE_OVERSIZED_NOTE,
  RESOURCE_TEXT_MAX_BYTES,
  type AppstrateRequestExtra,
  type AppstrateResourceProvider,
  type AppstrateToolDefinition,
  type ReadResourceResult,
} from "@appstrate/mcp-transport";
import {
  enrichTerminalRunAndWaitStep,
  launchRunAndWait,
  waitForRunAndWaitCompletion,
  INLINE_MANIFEST_RULE,
  RUN_AND_WAIT_MAX_MS,
  RUN_AND_WAIT_RESUME_INSTRUCTION,
  type RunAndWaitFile,
  type RunAndWaitLaunch,
} from "@appstrate/core/run-and-wait-client";
import type { ResolutionFieldError } from "@appstrate/core/api-errors";
import type { RunLogEvent } from "@appstrate/shared-types";
import { FILE_NAME_META_KEY, parseFileUri, fileUri } from "@appstrate/core/file-uri";
import { parseScopedName } from "@appstrate/core/naming";
import { SKILL_URI_PREFIX } from "@appstrate/core/skill-uri";
import {
  CONNECTION_RESOLUTION_WARNING_CODES,
  MAX_CONNECTIONS_PER_INTEGRATION,
} from "@appstrate/core/integration";
import { CONTEXT_FREE_FILENAMES_PHRASE } from "@appstrate/afps-runtime/bundle";
import type { Actor } from "@appstrate/connect";
import {
  getCatalog,
  collectReferencedSchemas,
  getRunAndWaitOutputSchema,
  operationGranted,
  operationIdGranted,
  type CatalogOperation,
} from "./catalog.ts";
import { internalDispatchHeader } from "../../lib/internal-dispatch.ts";
import { withoutConnectOffers } from "../../services/connect/preflight-connect-offer.ts";
import {
  credentialProxyClosedDetail,
  reachOutsideRunIfPermitted,
} from "../../services/credential-proxy/access.ts";
import type { SpaceContextRow } from "../../lib/space-lookup.ts";
import { logger } from "../../lib/logger.ts";
import { ceilingHolds } from "../../lib/route-requirements.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import {
  resolveFileAcrossSpaces,
  type FileAccess,
  readStoredFileBytes,
  projectFileMetadata,
  type FileCapabilities,
} from "../../services/files.ts";
import { isTextShapedMime, normalizeMime } from "../../services/mime-policy.ts";
import { isTextShapedContentType } from "@appstrate/core/mime";
import { VIEW_AS_HEADER } from "@appstrate/core/permissions";
import { filePurposeValues } from "@appstrate/db/schema";
import {
  asRecord,
  asString,
  dispatchHeaders,
  jsonResult,
  refusalResult,
  ToolRefusal,
  trySetHeader,
  type Refusal,
  type RouteRefusal,
} from "./tool-results.ts";
import {
  buildCallIntegrationToolTool,
  describeIntegrationTool,
  INTEGRATION_KIND_ANNOTATIONS,
  INTEGRATION_TOOLS_DESCRIPTION,
  observeListingRefusal,
  searchIntegrationTools,
  type IntegrationToolContext,
} from "./integration-tools.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  rankByKeywords,
  searchLimit,
  searchTokens,
} from "./search.ts";
import {
  describeAgent,
  describeSkill,
  listAgents,
  listSkills,
  readSpaces,
  skillSpaceRefusal,
  unsearched,
  type AgentHit,
  type McpSkillReader,
} from "./discovery.ts";
import { buildPackageFileTools } from "./package-file-tools.ts";
import {
  ACTIVE_SPACES_META_KEY,
  describeSpace,
  projectActiveInSpaces,
} from "@appstrate/core/mcp-spaces";
import type { DispatchContext } from "./api-call-batch.ts";
import {
  grantedIn,
  grantedSpaces,
  spaceIdsWhere,
  spaceArgumentRefusal,
  spaceRef,
  NO_FALLBACK_HINT,
  type McpSpace,
  type OrgWideSpaces,
  type OrgWideToolSpaces,
} from "./spaces.ts";
import { connectionIdSetJsonSchema } from "../../openapi/paths/integrations.ts";

/** Issue an in-process request back through the platform app. */
export type Dispatch = (req: Request) => Promise<Response>;

/** The tools, named for telemetry/audit. */
export type McpToolName =
  | "search"
  | "describe"
  | "invoke_operation"
  | "run_and_wait"
  | "list_files"
  | "read"
  | "validate_package_file"
  | "import_package_file"
  | "get_runtime_capabilities"
  | "call_integration_tool"
  | "get_me";

/** Outcome of an `invoke_operation` call, for audit + telemetry. */
export type McpInvokeOutcome =
  /** A refusal before dispatch (unknown operationId, missing path params, bad argument). */
  | "rejected"
  /** Dispatched in-process; `status` carries the operation's HTTP status. */
  | "invoked";

/**
 * A structured observation emitted by a tool handler. The tool layer stays
 * transport-agnostic: it emits plain data and lets the caller (the HTTP
 * router) decide what to do with it (audit log, telemetry). This keeps the
 * tools reusable by a future code-execution surface that has no Hono context.
 */
export interface McpToolEvent {
  tool: McpToolName;
  /** Wall-clock duration of the handler, milliseconds. */
  durationMs: number;
  /** Rows returned to the caller (after `limit`), not rows matched; `call_integration_tool`: its entries. */
  shownCount?: number;
  /** `search` on the organization endpoint: the spaces it searched. */
  spaceIds?: string[];
  /** `search`: operations withheld for lack of permission. */
  deniedCount?: number;
  /** `invoke_operation`: which operation, its method/path, and the outcome. */
  operationId?: string;
  method?: string;
  path?: string;
  status?: number;
  outcome?: McpInvokeOutcome;
  /** `run_and_wait`: the run's status when its wait ended (`pending`/`running` when the wait ran out first). */
  runStatus?: string;
}

export type McpObserver = (event: McpToolEvent) => void;

export interface McpToolContext {
  /** Origin of the inbound `/mcp` request, e.g. `https://instance.example`. */
  origin: string;
  /** Auth-relevant headers forwarded onto dispatched requests. */
  authHeaders: Headers;
  /** Effective permissions of the caller (from the session/token). */
  permissions: ReadonlySet<string>;
  /** A delegated credential's scopes (`scopeCeiling`); `undefined` for a session. Caps ceiling guards. */
  ceiling: ReadonlySet<string> | undefined;
  /**
   * The resolved caller identity (from the same forwarded auth the dispatched
   * requests carry). Lets the file resource provider call the files
   * service DIRECTLY — no in-process HTTP round-trip, so it works identically
   * across FS / S3-proxy / S3-presigned storage (the 307-redirect a fetch
   * cannot follow does not degrade the read).
   */
  actor: Actor;
  /** The caller's org+space scope (org fixed by the endpoint/token; space resolved). */
  scope: SpaceScope;
  /** How a file read by id reaches the file's own space (`requestFileAccess`), read on use. */
  fileAccess: () => Promise<FileAccess>;
  authorizeBundle: Parameters<typeof buildPackageFileTools>[0]["authorizeBundle"];
  placeRootAs: Parameters<typeof buildPackageFileTools>[0]["placeRootAs"];
  /** The inbound request's id, for the problem bodies a tool builds itself. */
  requestId: string;
  /**
   * Deliver the `run_log` frames (info and above) of a run the caller may read
   * until the returned function is called (`followRunLogs` in
   * `services/realtime-access.ts`). Feeds `run_and_wait`'s progress messages.
   */
  followRunLogs: (runId: string, onLog: (log: RunLogEvent) => void) => () => void;
  /** In-process dispatcher (defaults to the platform app at request time). */
  dispatch: Dispatch;
  /**
   * Optional sink for audit + telemetry events. Defaults to a no-op so unit
   * tests and any non-HTTP caller need not provide one.
   */
  observe?: McpObserver;
  /** Org-wide connection only: its spaces; `permissions` and `scope` are the entered one's. */
  orgSpaces?: OrgWideToolSpaces;
  /** The skills the connection reaches, through the Skills extension's reader (`./skills.ts`). */
  skills: McpSkillReader;
}

/** Never let an observer error affect the tool result. */
function emit(ctx: McpToolContext, event: McpToolEvent): void {
  try {
    ctx.observe?.(event);
  } catch {
    // Telemetry/audit is best-effort; swallow.
  }
}

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);
/**
 * Auth-context headers the router forwards from the inbound MCP request onto
 * every in-process dispatch (see `forwardAuthHeaders` in `router.ts`). They
 * carry the caller's identity/tenant and are the SAME set the model may not
 * override via the `headers` arg — `PROTECTED_HEADERS` is derived from this so
 * the two can never drift (a new forwarded auth header is protected by
 * construction).
 */
export const FORWARDED_AUTH_HEADERS = [
  "authorization",
  "cookie",
  "x-org-id",
  "appstrate-user",
  "appstrate-version",
  // A role preview narrows what the caller reaches; a dispatch that dropped it
  // would answer the model with the caller's REAL authority after the catalogue
  // had already been filtered by the persona.
  VIEW_AS_HEADER.toLowerCase(),
] as const;
// Headers the caller may NOT set via the `headers` arg: the auth context is
// forwarded from the inbound MCP request and must not be reshaped by the
// model (no swapping credentials, switching org/space, or forging end-user
// impersonation). Everything else (an operation's own `in: header` parameters)
// is allowed — still bounded by RBAC on the dispatched route. The forwarded auth
// set plus the hop-by-hop headers we set ourselves (`host`, `content-length`)
// and the internal self-dispatch marker: that marker is set by THIS layer (see
// the dispatch request build below) and exempts the request from outbound
// resource-audience confinement — a client-supplied value would be a forgery
// attempt, dropped here so only our authoritative, nonce-valued header survives.
// (Even without this, the value must equal an unguessable per-process secret, so
// a forgery cannot succeed; this is defence in depth.)
const PROTECTED_HEADERS = new Set<string>([
  ...FORWARDED_AUTH_HEADERS,
  // The router sets it to the space entered; `space_id` is the only way to change it.
  "x-space-id",
  "host",
  "content-length",
  // Client-source headers: the model must not be able to influence the
  // audited source IP of the in-process dispatch (the request pipeline
  // resolves the real client IP per `TRUST_PROXY`).
  "x-forwarded-for",
  "x-real-ip",
  internalDispatchHeader()[0],
]);
// Cap the buffered response body so a large list endpoint can't dump
// unbounded text into the model context. Truncation is flagged in the result.
const MAX_RESPONSE_CHARS = 100_000;

// --- files (resource_link + resources/read + list_files) -----------
// The `appfile://` URI prefix, id shape, and parser are the canonical,
// dependency-free helpers from `@appstrate/core/file-uri` (imported above)
// — the tool layer stays free of the files service's DB/storage graph
// while sharing one contract.

/** A published run file → the MCP `resource_link` content block (spec 2025-06-18). */
function fileResourceLink(doc: RunAndWaitFile): {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  description: string;
} {
  return {
    type: "resource_link",
    uri: doc.uri,
    name: doc.name,
    mimeType: doc.mime,
    size: doc.size,
    description: `File published by this run — read it with read or pass its URI to a follow-up run_and_wait input file field.`,
  };
}

/**
 * The full, invoke-ready definition of one operation: parameters, request body,
 * responses, and every referenced component schema inlined. This is the payload
 * `describe` returns for an operation.
 */
function describePayload(
  op: CatalogOperation,
  componentSchemas: Record<string, unknown>,
  ctx: Pick<McpToolContext, "permissions" | "ceiling" | "orgSpaces">,
): Record<string, unknown> {
  const granted = operationGranted(op, ctx.permissions, ctx.ceiling);
  return {
    ...(ctx.orgSpaces ? { space: spaceRef(ctx.orgSpaces.current) } : {}),
    ...grantedIn(ctx.orgSpaces, (s) => operationGranted(op, s.permissions, ctx.ceiling)),
    kind: "operation",
    id: op.operationId,
    method: op.method,
    path: op.pathTemplate,
    path_params: op.pathParams,
    summary: op.summary,
    description: op.description,
    // Only caller-space requirements decide `granted` — merging target-space ones
    // would pre-refuse an allowed cross-space call.
    required_permissions: op.requirement.requirements,
    target_space_permissions: op.requirement.targetSpaceRequirements,
    // Asked of a delegated credential's scopes only, never of the role.
    ceiling_permissions: op.requirement.ceilingRequirements,
    granted,
    ...(ctx.orgSpaces && !granted ? { hint: NO_FALLBACK_HINT } : {}),
    parameters: op.operation.parameters ?? [],
    request_body: op.operation.requestBody ?? null,
    responses: op.operation.responses ?? {},
    referenced_schemas: collectReferencedSchemas(op.operation, componentSchemas),
  };
}

/** A denial's ceiling half: named only when a delegated credential's scopes miss one. */
function deniedCeiling(
  op: CatalogOperation,
  ctx: Pick<McpToolContext, "ceiling">,
): { ceiling_permissions?: readonly string[] } {
  return ctx.ceiling !== undefined && !ceilingHolds(op.requirement.ceilingRequirements, ctx.ceiling)
    ? { ceiling_permissions: op.requirement.ceilingRequirements }
    : {};
}

/** The refusal of an operation the caller's permissions do not clear, in the space the call entered. */
function notGrantedRefusal(
  op: CatalogOperation,
  ctx: Pick<McpToolContext, "permissions" | "ceiling" | "orgSpaces">,
): Refusal {
  const reason =
    (ctx.ceiling === undefined
      ? "Your role does not hold this permission"
      : "Your role, or your credential's scopes, do not hold this permission") +
    (ctx.orgSpaces ? ` in ${describeSpace(ctx.orgSpaces.current)}` : "");
  return {
    code: "not_granted",
    error: `${reason}.`,
    required_permissions: op.requirement.requirements,
    ...deniedCeiling(op, ctx),
    ...grantedIn(ctx.orgSpaces, (s) => operationGranted(op, s.permissions, ctx.ceiling)),
    hint: ctx.orgSpaces
      ? `${NO_FALLBACK_HINT} Do not look for another operation that does the same thing.`
      : "Report it to the user; do not retry and do not look for another operation that does the same thing.",
  };
}

/** The kinds of things `search` finds and `describe` details. */
type DiscoveryKind = "operation" | "integration_tool" | "agent" | "skill";

/** What a kind's searcher is given: the call's arguments and the spaces it searches. */
interface SearchCall {
  ctx: McpToolContext;
  integrations: IntegrationToolContext;
  /** An org-wide call's spaces (the one it named, else every space reached); `undefined` when pinned. */
  spaces: readonly McpSpace[] | undefined;
  tokens: readonly string[];
  limit: number;
  tag: string | undefined;
  integration: string | undefined;
  /** `kinds` lists this kind: only then are remote catalogs read from their servers. */
  live: boolean;
  start: number;
  signal: AbortSignal | undefined;
}

/** A kind's section (`denied`: operations withheld), or the refusal that answers a call naming it. */
type KindSearch = (
  call: SearchCall,
) => Promise<
  | { section: Record<string, unknown>; denied?: number; searched?: string[] }
  | { refused: Refusal | RouteRefusal }
>;

/**
 * Per kind: its section of `search`, the tool that acts on it (named only to a caller whose
 * surface holds `act`), the argument that filters it, whether the caller is offered it (`granted`:
 * a read granted in some space reached) and its searcher. A kind whose search is refused is left
 * out unless the call named it, and then the refusal answers the call.
 */
const KINDS: Record<
  DiscoveryKind,
  {
    section: string;
    use: { tool: string; act?: "invokes" | "proxies" | "runs" };
    filter?: "tag" | "integration";
    declared: (granted: (operationId: string) => boolean, surface: McpSurface) => boolean;
    search: KindSearch;
  }
> = {
  operation: {
    section: "operations",
    use: { tool: "invoke_operation", act: "invokes" },
    filter: "tag",
    declared: () => true,
    search: searchOperations,
  },
  integration_tool: {
    section: "integration_tools",
    use: { tool: "call_integration_tool", act: "proxies" },
    filter: "integration",
    declared: (_granted, surface) => surface.proxies,
    search: searchIntegrationKind,
  },
  agent: {
    section: "agents",
    use: { tool: "run_and_wait", act: "runs" },
    declared: (g) => g("listAgents"),
    search: searchAgentKind,
  },
  skill: {
    section: "skills",
    use: { tool: "read" },
    declared: (g) => g("listSkills"),
    search: searchSkillKind,
  },
};

const kindsOf = Object.keys(KINDS) as DiscoveryKind[];

/** The kinds this caller may search and describe: each is declared only where its read is granted. */
function discoveryKinds(ctx: McpToolContext, surface: McpSurface): DiscoveryKind[] {
  const granted = (operationId: string): boolean =>
    ctx.orgSpaces
      ? ctx.orgSpaces.reachable.some((s) =>
          operationIdGranted(operationId, s.permissions, ctx.ceiling),
        )
      : operationIdGranted(operationId, ctx.permissions, ctx.ceiling);
  return kindsOf.filter((kind) => KINDS[kind].declared(granted, surface));
}

/**
 * The kinds a call searches, and those it named. Omitted `kinds` is every declared kind, or the
 * kinds of the filters passed; named kinds are checked against the declared ones and against the
 * filters, which a kind not searched cannot honour.
 */
function requestedKinds(
  args: Record<string, unknown>,
  declared: readonly DiscoveryKind[],
): { kinds: DiscoveryKind[]; named: ReadonlySet<DiscoveryKind> } | Refusal {
  const raw = args.kinds;
  const filtered = kindsOf.flatMap((kind) => {
    const { filter } = KINDS[kind];
    return filter && args[filter] !== undefined ? [{ kind, filter }] : [];
  });
  if (raw === undefined) {
    const named = new Set(filtered.map((f) => f.kind));
    return { kinds: declared.filter((kind) => named.size === 0 || named.has(kind)), named };
  }
  const valid = Array.isArray(raw) && raw.length > 0 && raw.every((k) => typeof k === "string");
  const unknown = valid
    ? (raw as string[]).filter((k) => !declared.includes(k as DiscoveryKind))
    : [];
  if (!valid || unknown.length > 0) {
    return {
      code: "invalid_argument",
      error: valid
        ? `Unknown kind(s): ${unknown.join(", ")}.`
        : "kinds must be a non-empty array of kinds.",
      arguments: ["kinds"],
      accepted: [...declared],
    };
  }
  const kinds = declared.filter((k) => (raw as string[]).includes(k));
  const stray = filtered.find((f) => !kinds.includes(f.kind));
  if (stray) {
    return {
      code: "invalid_argument",
      error: `\`${stray.filter}\` filters ${stray.kind} items, and kinds does not include ${stray.kind}.`,
      arguments: [stray.filter],
    };
  }
  return { kinds, named: new Set(kinds) };
}

/** A filter passed empty or malformed would widen the search instead of narrowing it: refuse it. */
function invalidFilter(args: Record<string, unknown>): Refusal | undefined {
  if (args.integration !== undefined) {
    const id = args.integration;
    if (typeof id !== "string" || parseScopedName(id) === null) {
      return {
        code: "invalid_argument",
        error: "`integration` must be an integration's package id, `@scope/name`.",
        arguments: ["integration"],
      };
    }
  }
  if (args.tag !== undefined && (typeof args.tag !== "string" || args.tag.trim() === "")) {
    return {
      code: "invalid_argument",
      error: "`tag` must be a non-empty string.",
      arguments: ["tag"],
    };
  }
  return undefined;
}

/** Read-only, unless the kind of integration tools is declared: reading its catalog reaches third-party servers. */
function discoveryAnnotations(title: string, kinds: readonly DiscoveryKind[]): Tool["annotations"] {
  return kinds.includes("integration_tool")
    ? { title, ...INTEGRATION_KIND_ANNOTATIONS }
    : { title, readOnlyHint: true, idempotentHint: true, openWorldHint: false };
}

function buildSearchTool(
  ctx: McpToolContext,
  surface: McpSurface,
  integrations: IntegrationToolContext,
): AppstrateToolDefinition {
  const kinds = discoveryKinds(ctx, surface);
  const uses = kinds
    .filter((kind) => !KINDS[kind].use.act || surface[KINDS[kind].use.act!])
    .map((kind) => `${KINDS[kind].section} → ${KINDS[kind].use.tool}`)
    .join(", ");
  const descriptor: Tool = {
    name: "search",
    description:
      `Search what you can act on, by keyword: ${kinds.map((k) => KINDS[k].section).join(", ")}. ` +
      "Returns one section per kind searched, each with its `total` and its `items`, capped at " +
      "`limit`; every item carries the `id` describe takes. " +
      (uses ? `Each kind is used by its own tool: ${uses}. ` : "") +
      "Without keywords, a section lists its kind (`tag` narrows operations). Operations your " +
      "role may not invoke are listed apart under `denied`, with the permissions they need: " +
      "report that to the user instead of trying them." +
      (kinds.includes("integration_tool") ? INTEGRATION_TOOLS_DESCRIPTION : ""),
    annotations: discoveryAnnotations("Search", kinds),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Free-text keywords, matched against each item's id or name and its description.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: [...kinds] },
          uniqueItems: true,
          description:
            `What to search: ${kinds.map((k) => `\`${k}\``).join(", ")}. Omitted, every kind is ` +
            "searched, or only the kinds whose filter (`tag`, `integration`) is passed.",
        },
        tag: {
          type: "string",
          description: "Operations only: restrict to one OpenAPI tag (e.g. 'Agents').",
        },
        ...(kinds.includes("integration_tool")
          ? {
              integration: {
                type: "string",
                description:
                  "Integration tools only: restrict to one integration, by package id " +
                  "(`@scope/name`). Its remote catalog is read from its server only when `kinds` " +
                  "lists `integration_tool`.",
              },
            }
          : {}),
        limit: {
          type: "integer",
          description: `Max items per kind (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
      },
    },
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    const invalid = invalidFilter(args);
    if (invalid) return refusalResult(invalid);
    const requested = requestedKinds(args, kinds);
    if ("code" in requested) return refusalResult(requested);
    const call = {
      ctx,
      integrations,
      // Org-wide: the space named, else every space reached; pinned: the one the endpoint is in.
      spaces: ctx.orgSpaces
        ? args.space_id !== undefined
          ? [ctx.orgSpaces.current]
          : ctx.orgSpaces.reachable
        : undefined,
      tokens: searchTokens(args.query),
      limit: searchLimit(args.limit),
      tag: asString(args.tag)?.toLowerCase(),
      integration: asString(args.integration),
      start,
      signal: extra.signal,
    };
    const outcomes = await Promise.all(
      requested.kinds.map(async (kind) => {
        const named = requested.named.has(kind);
        const live = Array.isArray(args.kinds) && named;
        return { kind, named, outcome: await KINDS[kind].search({ ...call, live }) };
      }),
    );
    const sections: Record<string, unknown> = {};
    let shown = 0;
    let denied: number | undefined;
    const searched = new Set<string>();
    for (const { kind, named, outcome } of outcomes) {
      if ("refused" in outcome) {
        if (named) return refusalResult(outcome.refused);
        continue;
      }
      sections[KINDS[kind].section] = outcome.section;
      shown += Array.isArray(outcome.section.items) ? outcome.section.items.length : 0;
      denied = outcome.denied ?? denied;
      for (const id of outcome.searched ?? []) searched.add(id);
    }
    emit(ctx, {
      tool: "search",
      durationMs: performance.now() - start,
      shownCount: shown,
      ...(call.spaces ? { spaceIds: call.spaces.map((space) => space.id) } : {}),
      ...(denied !== undefined ? { deniedCount: denied } : {}),
    });
    // Without `space_id`, the spaces whose data was read: what the chat records as read.
    const readSpaceIds = ctx.orgSpaces && args.space_id === undefined ? [...searched] : [];
    return jsonResult({
      ...sections,
      ...(readSpaceIds.length > 0 ? { searched_spaces: readSpaceIds } : {}),
    });
  };

  return { descriptor, handler };
}

/** A dispatch context reading in `space`, or in the one space a pinned connection enters. */
function readingIn(ctx: McpToolContext, space: McpSpace | undefined): DispatchContext {
  return space && ctx.orgSpaces
    ? {
        origin: ctx.origin,
        authHeaders: ctx.authHeaders,
        dispatch: ctx.orgSpaces.dispatchIn(space.id),
      }
    : ctx;
}

async function searchOperations({ ctx, spaces, tokens, tag, limit }: SearchCall) {
  let matches = [...getCatalog().operations.values()];
  if (tag) matches = matches.filter((op) => op.tags.some((t) => t.toLowerCase() === tag));
  const scored = rankByKeywords(
    matches.sort((a, b) => a.operationId.localeCompare(b.operationId)),
    tokens,
    (op) => ({
      name: op.operationId,
      text: `${op.summary} ${op.description} ${op.pathTemplate} ${op.tags.join(" ")}`,
    }),
  );
  const grantedHere = (op: CatalogOperation) => (space: McpSpace) =>
    operationGranted(op, space.permissions, ctx.ceiling);

  // A denied match is answered, not hidden — its id and requirement only.
  const granted: CatalogOperation[] = [];
  const denied: CatalogOperation[] = [];
  for (const { item } of scored) {
    const listed = spaces
      ? spaces.some(grantedHere(item))
      : operationGranted(item, ctx.permissions, ctx.ceiling);
    (listed ? granted : denied).push(item);
  }
  return {
    denied: denied.length,
    section: {
      total: granted.length,
      items: granted.slice(0, limit).map((op) => ({
        id: op.operationId,
        method: op.method,
        path: op.pathTemplate,
        summary: op.summary,
        tags: op.tags,
        ...(spaces ? { granted_in: spaceIdsWhere(spaces, grantedHere(op)) } : {}),
      })),
      ...(denied.length > 0
        ? {
            denied_total: denied.length,
            denied: denied.slice(0, limit).map((op) => ({
              id: op.operationId,
              required_permissions: op.requirement.requirements,
              ...deniedCeiling(op, ctx),
              // Not searched spaces: where it is granted instead, so the user can be pointed there.
              ...(ctx.orgSpaces
                ? { granted_in: spaceIdsWhere(ctx.orgSpaces.reachable, grantedHere(op)) }
                : {}),
            })),
          }
        : {}),
    },
  };
}

async function searchAgentKind({ ctx, spaces, tokens, limit, signal }: SearchCall) {
  const { answered, refused } = await readSpaces(spaces, (space) =>
    listAgents(readingIn(ctx, space), signal),
  );
  // A space whose route refuses is reported; all refusing answers the first.
  if (answered.length === 0 && refused[0]) return { refused: refused[0].refused };
  const merged = new Map<string, { hit: AgentHit; spaceIds: string[] }>();
  for (const { space, value } of answered) {
    for (const hit of value.agents) {
      const found = merged.get(hit.id) ?? { hit, spaceIds: [] };
      if (space) found.spaceIds.push(space.id);
      merged.set(hit.id, found);
    }
  }
  const matches = rankByKeywords([...merged.values()], tokens, ({ hit }) => ({
    name: hit.id,
    text: `${hit.display_name} ${hit.description}`,
  }));
  return {
    section: {
      total: matches.length,
      items: matches
        .slice(0, limit)
        .map(({ item }) => ({ ...item.hit, ...(spaces ? { granted_in: item.spaceIds } : {}) })),
      ...unsearched(refused),
    },
    searched: answered.flatMap(({ space }) => (space ? [space.id] : [])),
  };
}

async function searchSkillKind({ ctx, spaces, tokens, limit }: SearchCall) {
  // A skill kind is searched where `listSkills` is granted; elsewhere the space is refused.
  const targets = spaces ?? [{ id: ctx.scope.spaceId, permissions: ctx.permissions }];
  const readable = targets.filter((space) =>
    operationIdGranted("listSkills", space.permissions, ctx.ceiling),
  );
  const { answered, refused: unreadable } = await readSpaces(readable, (space) =>
    listSkills(ctx.skills, space.id, ctx.requestId),
  );
  const refused = [
    ...targets
      .filter((space) => !readable.includes(space))
      .map((space) => ({
        space,
        refused: {
          status: 403,
          body: {
            code: "not_granted",
            error: `Your role does not allow listing skills in space ${space.id}.`,
          },
        },
      })),
    ...unreadable,
  ].map((entry) => ({ ...entry, space: spaces ? entry.space : undefined }));
  if (answered.length === 0 && refused[0]) return { refused: refused[0].refused };
  const matches = rankByKeywords(
    answered.flatMap(({ value }) => value.skills),
    tokens,
    (skill) => ({ name: skill.name, text: `${skill.packageId} ${skill.description}` }),
  );
  return {
    section: {
      total: matches.length,
      items: matches
        .slice(0, limit)
        .map(({ item: { granted_in, ...hit } }) => (spaces ? { ...hit, granted_in } : hit)),
      ...unsearched(refused),
    },
    searched: answered.map(({ space }) => space.id),
  };
}

/**
 * Why integration tools may not be searched or described in the space an org-wide call names: the
 * space's closed credential proxy, or the caller's role there; `undefined` when they may. A pinned
 * connection declares the kind only where they may.
 */
function integrationKindRefusal(ctx: McpToolContext): Refusal | undefined {
  return ctx.orgSpaces ? spaceActRefusal(ctx.orgSpaces, "proxies", "integration tools") : undefined;
}

/**
 * The integration tools section: remote catalogs are read from their servers only when `kinds`
 * lists the kind, from the cache otherwise; across spaces, in those that allow it.
 */
async function searchIntegrationKind({
  ctx,
  integrations,
  spaces,
  tokens,
  limit,
  integration,
  live,
  start,
  signal,
}: SearchCall) {
  const allowed = spaces?.filter((space) => space.surface.proxies);
  const refusal = allowed?.length === 0 ? integrationKindRefusal(ctx) : undefined;
  if (refusal) return { refused: refusal };
  const found = await searchIntegrationTools(
    allowed,
    (space) => ({ ...integrations, dispatch: readingIn(ctx, space).dispatch }),
    {
      tokens,
      limit,
      cachedOnly: !live,
      ...(integration !== undefined ? { integration } : {}),
    },
    signal,
  );
  if ("refused" in found) observeListingRefusal(integrations, "search", start, found.refused);
  return found;
}

function buildDescribeTool(
  ctx: McpToolContext,
  surface: McpSurface,
  integrations: IntegrationToolContext,
): AppstrateToolDefinition {
  const { invokes } = surface;
  const kinds = discoveryKinds(ctx, surface);
  const descriptor: Tool = {
    name: "describe",
    description:
      "Return everything needed to act on one item search returned, by its `kind` and `id`. " +
      "An `operation`: its full OpenAPI definition (parameters, request body, responses) with " +
      "every referenced component schema inlined" +
      (invokes ? ", to build a valid invoke_operation call (its `id` is the `operation_id`)" : "") +
      "; whether your role clears the route's guards (`granted`) and the permissions it requires " +
      "in the space of the call (`required_permissions`). `target_space_permissions` are decided in the " +
      "space the path names, never here; `ceiling_permissions` apply only through a delegated " +
      "credential (API key, OAuth token), whose scopes must include each. A granted operation " +
      "can still be refused on the record it acts on; that refusal names its reason." +
      (kinds.includes("agent")
        ? " An `agent`: its launch contract at the definition a launch by you runs (input " +
          "schema, stored values, locked fields, output, declared integrations)" +
          (surface.runs ? " and the `run_with` call that launches it." : ".")
        : "") +
      (kinds.includes("skill")
        ? " A `skill`: its frontmatter and the `skill://` URI of each of its files, to read " +
          "with read."
        : "") +
      (kinds.includes("integration_tool")
        ? " An `integration_tool`: its `input_schema`, a typed tool's `output_schema` when its " +
          "server declares one, the `connections` it reaches and its `usage`: how to call it " +
          "with call_integration_tool, how to read its result and what its connections' fields " +
          "mean. Its remote catalog is read from its server when not cached."
        : ""),
    annotations: discoveryAnnotations("Describe", kinds),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: [...kinds],
          description: "The item's kind, as search returned it.",
        },
        id: {
          type: "string",
          description:
            "The item's `id`, as search returned it (or already known: an operationId, an agent's " +
            "`@scope/name`, a skill's `skill://` URI, an integration tool's name).",
        },
      },
      required: ["kind", "id"],
    },
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    const kind = asString(args.kind) as DiscoveryKind | undefined;
    const id = asString(args.id);
    // A malformed call is a refusal result, not a failed execution: the model
    // sees what is missing and can self-correct.
    const missing = [...(kind ? [] : ["kind"]), ...(id ? [] : ["id"])];
    if (missing.length > 0) {
      return refusalResult({
        code: "missing_argument",
        error: missing.map((name) => `${name} is required.`).join(" "),
        arguments: missing,
      });
    }
    if (!kinds.includes(kind!)) {
      return refusalResult({
        code: "invalid_argument",
        error: `Unknown kind: ${kind}.`,
        arguments: ["kind"],
        accepted: [...kinds],
      });
    }
    if (kind === "integration_tool") {
      const refusal = integrationKindRefusal(ctx);
      return refusal
        ? refusalResult(refusal)
        : describeIntegrationTool(integrations, id!, extra.signal);
    }
    const result = await describeItem(kind!, id!);
    // An unknown operationId is not an event.
    if (kind !== "operation" || !result.isError) {
      emit(ctx, {
        tool: "describe",
        durationMs: performance.now() - start,
        ...(kind === "operation" ? { operationId: id } : {}),
      });
    }
    return result;
  };

  const describeItem = async (kind: DiscoveryKind, id: string): Promise<CallToolResult> => {
    switch (kind) {
      case "agent": {
        const current = ctx.orgSpaces?.current;
        const described = await describeAgent(
          ctx,
          id,
          (current ? current.surface.runs : surface.runs) ? { spaceId: current?.id } : null,
        );
        if ("refused" in described) return refusalResult(described.refused);
        if ("refusal" in described) return refusalResult(described.refusal);
        return jsonResult({
          kind: "agent",
          ...described.agent,
          ...(current ? { space: spaceRef(current) } : {}),
        });
      }
      case "skill": {
        const described = await describeSkill(ctx.skills, id, ctx.scope.spaceId);
        return "skill" in described
          ? jsonResult({ kind: "skill", ...described.skill })
          : refusalResult(described.refusal);
      }
      default: {
        const { operations, componentSchemas } = getCatalog();
        const op = operations.get(id);
        return op
          ? jsonResult(describePayload(op, componentSchemas, ctx))
          : refusalResult({
              code: "unknown_operation",
              error: `Unknown operationId: ${id}. Find it with search.`,
              arguments: ["id"],
            });
      }
    }
  };

  return { descriptor, handler };
}

/**
 * Encode a path-param value while preserving the two literals Appstrate's
 * scoped-id routes match: `@` and `/`.
 *
 * Package identifiers carry an `@` sigil and may span two segments — the
 * `{scope}`/`{name}` split (`@appstrate` + `my-agent`) but also a single
 * `{packageId}` param whose value IS `@scope/name` (the Integrations family:
 * `/api/integrations/{packageId}` → route `:packageId{@[^/]+/[^/]+}`). The
 * platform's own clients send both `@` and `/` raw, so `encodeURIComponent`
 * (which turns them into `%40`/`%2F`) breaks route matching → 404. Restore
 * both; everything else (spaces, etc.) stays percent-encoded.
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/%40/g, "@").replace(/%2F/g, "/");
}

/**
 * Whether a caller-supplied path-param value is safe to interpolate without
 * altering the route the `operationId` binds to.
 *
 * `encodePathSegment` deliberately restores `/` (for scoped ids), so an
 * unchecked value could smuggle extra path structure: `name="../api-keys"`
 * would normalise `/api/agents/../api-keys` → `/api/agents/api-keys`, and
 * `name="x/runs"` would re-route to `/api/agents/x/runs` — both dispatching a
 * DIFFERENT operation than the audited `operationId` (and mis-recording the
 * audit trail). `path_params` is `additionalProperties: true`, so the value is
 * fully client-controlled.
 *
 * Rules: no control chars or backslashes; no empty / `.` / `..` segments
 * (traversal, leading/trailing/double slash); and slashes are allowed ONLY for
 * a scoped package id — leading `@` with exactly one internal slash
 * (`@scope/name`). Every other value must be a single path segment.
 */
function isSafePathParamValue(value: string): boolean {
  if (value === "") return false;
  // eslint-disable-next-line no-control-regex -- intentionally matching control chars
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  const segments = value.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  if (segments.length > 1 && !(value.startsWith("@") && segments.length === 2)) return false;
  return true;
}

type Scalar = string | number | boolean;

// `String(x)` on an object yields "[object Object]"; only scalars have a
// faithful text form for a URL.
function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Name of the first path/query parameter holding a non-scalar value, or null.
 * The inputSchema declares the same constraint, but the SDK does not enforce it.
 */
function findNonScalarParam(
  op: CatalogOperation,
  pathParams: Record<string, unknown>,
  query: Record<string, unknown>,
): string | null {
  for (const name of op.pathParams) {
    const value = pathParams[name];
    if (value != null && !isScalar(value)) return `path_params.${name}`;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value) ? !value.every(isScalar) : !isScalar(value)) return `query.${key}`;
  }
  return null;
}

function interpolatePath(op: CatalogOperation, pathParams: Record<string, unknown>): string | null {
  let path = op.pathTemplate;
  for (const name of op.pathParams) {
    const value = pathParams[name];
    if (value === undefined || value === null) return null;
    const raw = String(value);
    if (!isSafePathParamValue(raw)) return null;
    path = path.replace(`{${name}}`, encodePathSegment(raw));
  }
  return path;
}

/**
 * Read a dispatched response into a tool result, defensively:
 *  - Streaming (`text/event-stream`) bodies are refused, NOT buffered —
 *    `.text()` on an open SSE stream never resolves and would hang the
 *    server promise (the platform exposes SSE GET operations).
 *  - Non-text bodies (downloads, tarballs) are summarised, not decoded.
 *  - Text bodies are capped to bound context size.
 *  - `extra` is merged into the payload (e.g. what a 403 required).
 */
export async function readResponse(
  response: Response,
  extra?: Record<string, unknown>,
  eligibleLaunchSpaces?: () => readonly { id: string }[],
): Promise<CallToolResult> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isError = response.status >= 400;

  if (contentType.includes("text/event-stream")) {
    return jsonResult(
      {
        status: response.status,
        error:
          "This operation streams (text/event-stream) and is not supported via invoke_operation. Consume the realtime/SSE endpoint directly.",
        ...extra,
      },
      true,
    );
  }

  // Same predicate as every other text/binary decision in the platform
  // (`@appstrate/core/mime`) — a package download served as OOXML must be
  // summarised, never decoded. An ABSENT Content-Type stays textual here, which
  // the shared predicate deliberately refuses: this path only ever reads our own
  // API, whose bodiless 204s carry no type and must not be reported as an
  // omitted binary.
  const isTextual = contentType === "" || isTextShapedContentType(contentType);
  if (!isTextual) {
    const len = response.headers.get("content-length");
    return jsonResult(
      {
        status: response.status,
        note: "Non-text response body omitted.",
        content_type: contentType,
        bytes: len ? Number(len) : null,
        ...extra,
      },
      isError,
    );
  }

  let raw = await response.text();
  let body: unknown = raw;
  let spaceIds: string[] = [];
  const launchProblem =
    eligibleLaunchSpaces &&
    (response.status === 403 || response.status === 404 || response.status === 409);
  if (contentType.includes("json") && raw && (raw.length <= MAX_RESPONSE_CHARS || launchProblem)) {
    try {
      body = JSON.parse(raw);
    } catch {
      // A non-JSON response under a JSON content type stays text.
    }
    if (launchProblem) {
      const projected = projectActiveInSpaces(body, eligibleLaunchSpaces);
      if (projected) {
        body = projected.body;
        raw = JSON.stringify(body);
        spaceIds = projected.ids;
      }
    }
  }
  const truncated = raw.length > MAX_RESPONSE_CHARS;
  if (truncated) {
    // A text prefix cannot carry a reliable list of the spaces it reveals. Keep the
    // diagnostic and omit all alternatives before slicing, including partial names.
    if (spaceIds.length) {
      raw = JSON.stringify(projectActiveInSpaces(body, () => [])!.body);
      spaceIds = [];
    }
    body = raw.slice(0, MAX_RESPONSE_CHARS);
  }

  // The version to send back as `if_match` on the next write to this resource.
  const etag = response.headers.get("etag");
  const result = jsonResult(
    {
      status: response.status,
      ...(etag ? { etag } : {}),
      ...(truncated ? { truncated: true } : {}),
      body,
      ...extra,
    },
    isError,
  );
  if (spaceIds.length) result._meta = { [ACTIVE_SPACES_META_KEY]: spaceIds };
  return result;
}

function applyQuery(url: URL, query: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

function buildInvokeTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "invoke_operation",
    description:
      "Execute an Appstrate API operation. Call describe first to learn its " +
      "path_params, query, and body shapes. Runs with your own credentials and permissions; " +
      "the request is validated and authorized exactly as the equivalent REST call. " +
      "Optimistic concurrency: a result carries `etag` when the resource is versioned — " +
      "pass it back as `if_match` on the next write to that resource. A write refused with " +
      "412 means it changed since you read it: re-read, reapply your change, retry; 428 means " +
      "the write requires `if_match` (package draft updates do — read the package first).",
    annotations: {
      title: "Invoke API operation",
      // Dispatches any of ~222 operations, including POST/PUT/DELETE — declare
      // it non-read-only, potentially destructive, non-idempotent, open-world
      // so clients prompt for confirmation appropriately.
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation_id: { type: "string", description: "The operationId to invoke." },
        path_params: {
          type: "object",
          description: "Values for path placeholders, e.g. { scope, name }.",
          additionalProperties: { type: ["string", "number", "boolean"] },
        },
        query: {
          type: "object",
          description: "Query-string parameters; an array repeats the key.",
          additionalProperties: {
            anyOf: [
              { type: ["string", "number", "boolean", "null"] },
              { type: "array", items: { type: ["string", "number", "boolean"] } },
            ],
          },
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/PATCH).",
          additionalProperties: true,
        },
        if_match: {
          type: "string",
          description:
            "The `etag` of the representation this write is based on, sent as the If-Match " +
            "header (copy it verbatim from the result that returned it, quotes included).",
        },
        headers: {
          type: "object",
          description:
            "Request headers (string values) for operations that declare an 'in: header' " +
            "parameter, e.g. If-None-Match on a conditional read. (Such params are also " +
            "auto-detected if passed in `query`.) Auth headers (authorization, cookie, x-org-id, " +
            "…) are forwarded from your session and cannot be overridden here.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["operation_id"],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const operationId = asString(args.operation_id);

    // A malformed call is a refusal result (`isError`), never a JSON-RPC error,
    // and the telemetry `rejected` event is still emitted first. Upstream HTTP
    // failures (and a denial the route decides) are operation outcomes.
    if (!operationId) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult({
        code: "missing_argument",
        error: "operation_id is required.",
        arguments: ["operation_id"],
      });
    }

    const { operations } = getCatalog();
    const op = operations.get(operationId);
    if (!op) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        outcome: "rejected",
      });
      return refusalResult({
        code: "unknown_operation",
        error: `Unknown operationId: ${operationId}. Find it with search.`,
        arguments: ["operation_id"],
      });
    }

    const pathParams = asRecord(args.path_params) ?? {};
    const query = asRecord(args.query) ?? {};
    const nonScalar = findNonScalarParam(op, pathParams, query);
    if (nonScalar !== null) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        method: op.method,
        outcome: "rejected",
      });
      return refusalResult({
        code: "invalid_argument",
        error:
          `Invalid ${nonScalar}: only string, number or boolean values are accepted ` +
          "(query also accepts arrays of those).",
        arguments: [nonScalar],
      });
    }
    const path = interpolatePath(op, pathParams);
    if (path === null) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        method: op.method,
        outcome: "rejected",
      });
      return refusalResult({
        code: "missing_argument",
        error: `Missing path_params. Required: ${op.pathParams.join(", ")}`,
        arguments: ["path_params"],
        accepted: op.pathParams,
      });
    }

    // An invalid model-supplied header is a tool error, not a 500.
    const rejectHeader = (name: string, argument: string): CallToolResult => {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        method: op.method,
        outcome: "rejected",
      });
      return refusalResult({
        code: "invalid_argument",
        error: `Invalid header name or value: ${name}`,
        arguments: [argument],
      });
    };
    const headers = new Headers(ctx.authHeaders);
    const ifMatch = asString(args.if_match);
    if (ifMatch && !trySetHeader(headers, "If-Match", ifMatch))
      return rejectHeader("If-Match", "if_match");
    const extraHeaders = asRecord(args.headers);
    if (extraHeaders) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        if (PROTECTED_HEADERS.has(name.toLowerCase())) continue;
        if (typeof value !== "string") continue;
        if (!trySetHeader(headers, name, value)) return rejectHeader(name, `headers.${name}`);
      }
    }
    // Auto-map OpenAPI `in: header` parameters: a model often supplies a
    // declared header value in `query` (or the operation simply requires a
    // header it can't express otherwise, e.g. a conditional read's
    // If-None-Match). For each declared header param not already set,
    // pull its value from `query` (case-insensitive) and move it to a header.
    for (const headerName of op.headerParams) {
      if (PROTECTED_HEADERS.has(headerName.toLowerCase())) continue;
      if (headers.has(headerName)) continue;
      const queryKey = Object.keys(query).find((k) => k.toLowerCase() === headerName.toLowerCase());
      if (queryKey === undefined) continue;
      const value = query[queryKey];
      if (typeof value === "string" || typeof value === "number") {
        if (!trySetHeader(headers, headerName, String(value)))
          return rejectHeader(headerName, `headers.${headerName}`);
        delete query[queryKey];
      }
    }

    const url = new URL(path, ctx.origin);
    applyQuery(url, query);

    // Every Appstrate API request body is a JSON object. A model that passes
    // an array or primitive as `body` would otherwise have it silently
    // dropped by `asRecord` (→ request sent with no body → confusing 400).
    // Surface a clear tool error instead so the model can self-correct.
    if (args.body !== undefined && args.body !== null && asRecord(args.body) === undefined) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        method: op.method,
        outcome: "rejected",
      });
      return refusalResult({
        code: "invalid_argument",
        error: "`body` must be a JSON object.",
        arguments: ["body"],
      });
    }
    const body = asRecord(args.body);
    const sendBody = body !== undefined && METHODS_WITH_BODY.has(op.method);
    if (sendBody) headers.set("content-type", "application/json");

    // Mark this as a trusted in-process self-dispatch. The inbound MCP request
    // already cleared the `/api/mcp/o/:org` resource boundary's audience check; this
    // re-entry targets a non-resource route (`/api/agents`, …) carrying the
    // same audience-bound token, which the outbound half of
    // `enforceResourceAudience` would otherwise reject. The marker value is an
    // unguessable per-process secret, so it cannot be forged from outside (and
    // any client-supplied copy was dropped by PROTECTED_HEADERS above).
    headers.set(...internalDispatchHeader());

    const request = new Request(url.toString(), {
      method: op.method,
      headers,
      body: sendBody ? JSON.stringify(body) : undefined,
    });

    const response = await ctx.dispatch(request);
    emit(ctx, {
      tool: "invoke_operation",
      durationMs: performance.now() - start,
      operationId,
      method: op.method,
      path,
      status: response.status,
      outcome: "invoked",
    });
    // Only a 403 the permission set explains gets the permission answer; one the
    // ROW decided (a file ACL, `draft_not_writable`) already names its reason.
    const denial =
      response.status === 403 && !operationGranted(op, ctx.permissions, ctx.ceiling)
        ? notGrantedRefusal(op, ctx)
        : undefined;
    const space = ctx.orgSpaces ? { space: spaceRef(ctx.orgSpaces.current) } : undefined;
    return readResponse(response, space || denial ? { ...space, ...denial } : undefined, () =>
      (ctx.orgSpaces?.reachable ?? []).filter(
        (s) => s.surface.invokes && operationGranted(op, s.permissions, ctx.ceiling),
      ),
    );
  };

  return { descriptor, handler };
}

// --- run_and_wait ----------------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Aborted");
}

/** Well under the SDK client's request timeout, which each progress notification resets. */
export const RUN_AND_WAIT_PROGRESS_INTERVAL_MS = DEFAULT_REQUEST_TIMEOUT_MSEC / 4;
/**
 * Wait budget, in seconds and launch included, of a call without `wait`: 10 s under the
 * 60 s per-call timeout that is the shortest one MCP clients commonly apply, whether or
 * not they send a progress token.
 */
export const RUN_AND_WAIT_DEFAULT_WAIT_SECONDS = 50;
/** Ceiling of the `wait` argument, in seconds: the fallback wait ceiling of `run_and_wait`. */
export const RUN_AND_WAIT_MAX_WAIT_SECONDS = RUN_AND_WAIT_MAX_MS / 1000;

export const WARNING_CODES_PHRASE = CONNECTION_RESOLUTION_WARNING_CODES.map((c) => `\`${c}\``).join(
  ", ",
);

/** The resume instruction for a caller with time to wait (not the chat). */
export const RUN_AND_WAIT_LONG_POLL_RESUME = `${RUN_AND_WAIT_RESUME_INSTRUCTION} \`query: { wait: true }\` holds that read until the run ends.`;

/** At most one log notification per period; a line arriving within it waits, replaced by any newer one. */
export const RUN_AND_WAIT_LOG_PROGRESS_INTERVAL_MS = 1_000;
/** Longest log message a progress notification carries, in code points. */
export const RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS = 200;

/** `Run <id> [<level>] <message>` on one line, message cut to its cap; `null` for nothing to show. */
function logProgressMessage(runId: string, log: RunLogEvent): string | null {
  if (log.level === "debug") return null;
  const line = (log.message ?? "").replace(/\s+/g, " ").trim();
  if (line === "") return null;
  // Counted and cut in code points, so a character outside the BMP is never split.
  const chars = [...line];
  const message =
    chars.length > RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS
      ? `${chars.slice(0, RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS - 1).join("")}…`
      : line;
  return `Run ${runId} [${log.level}] ${message}`;
}

/**
 * Progress of a streamed `run_and_wait` (the caller sent a `progressToken`): a
 * heartbeat every {@link RUN_AND_WAIT_PROGRESS_INTERVAL_MS} plus the run's
 * latest log line, throttled to {@link RUN_AND_WAIT_LOG_PROGRESS_INTERVAL_MS}.
 * Both share one strictly increasing `progress` counter. `null` without a token.
 *
 * The returned stop takes whether the wait completed: a completed wait first
 * sends the line still held by the throttle (often the run's final error), as
 * the response has not left yet; a cancelled or disconnected call sends nothing.
 */
function startRunProgress(
  ctx: McpToolContext,
  extra: AppstrateRequestExtra,
  runId: string,
): ((waitCompleted: boolean) => void) | null {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return null;
  const startedAt = performance.now();
  let progress = 0;
  const beat = (message: string) =>
    notifyDetached(
      extra,
      {
        method: "notifications/progress",
        params: { progressToken, progress: ++progress, message },
      },
      (err) =>
        logger.debug("mcp: run_and_wait progress notification failed", {
          runId,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  beat(`Run ${runId} launched`);
  const timer = setInterval(() => {
    const elapsedS = Math.round((performance.now() - startedAt) / 1000);
    beat(`Waiting for run ${runId} (${elapsedS}s elapsed)`);
  }, RUN_AND_WAIT_PROGRESS_INTERVAL_MS);

  let cooldown: ReturnType<typeof setTimeout> | undefined;
  let waiting: string | null = null;
  const sendLog = (message: string) => {
    beat(message);
    cooldown = setTimeout(() => {
      cooldown = undefined;
      if (waiting === null) return;
      const next = waiting;
      waiting = null;
      sendLog(next);
    }, RUN_AND_WAIT_LOG_PROGRESS_INTERVAL_MS);
  };
  const stopLogs = ctx.followRunLogs(runId, (log) => {
    const message = logProgressMessage(runId, log);
    if (message === null) return;
    if (cooldown === undefined) sendLog(message);
    else waiting = message;
  });

  return (waitCompleted) => {
    clearInterval(timer);
    clearTimeout(cooldown);
    if (waitCompleted && waiting !== null && !extra.signal?.aborted) beat(waiting);
    stopLogs();
  };
}

/**
 * `run_and_wait` arguments that exist only for `kind:"inline"`. Declared only
 * to a caller whose surface `composes`; another caller sending one gets the
 * undeclared-argument refusal (`refuseUndeclaredArguments`), and the route's
 * 403 still owns the rule behind it.
 */
const INLINE_ONLY_RUN_AND_WAIT_PROPERTIES: Record<string, object> = {
  manifest: {
    type: "object",
    description:
      `${INLINE_MANIFEST_RULE} Do NOT put the prompt inside the manifest — it goes in the ` +
      "separate top-level `prompt` argument.",
    properties: {
      display_name: {
        type: "string",
        description:
          "Concise human title, in the user's language, of the exact action or outcome of THIS " +
          'run (for example "Analyse des 3 derniers e-mails"): the run card, run lists and run ' +
          "page show it. Never an id or a generic name such as `one-shot` or `task`. When " +
          "`name` is omitted the platform derives @inline/<slug> from it.",
      },
      name: {
        type: "string",
        description:
          "Optional exact canonical @scope/name override. Usually omit and provide " +
          "display_name.",
      },
      dependencies: {
        type: "object",
        description:
          "Exact AFPS dependencies override. `integrations` maps each `@scope/name` to its " +
          "version: take both from `get_me` (`integration_package_id`, `version`).",
        additionalProperties: true,
      },
      integrations_configuration: {
        type: "object",
        description:
          "Exact AFPS integration configuration override. Per integration, `tools` lists the " +
          "exact tool names the task needs and no more (`api_call` covers most third-party REST " +
          "calls; omit it only to take the integration's whole `default_tools`; `getIntegration` " +
          "returns `default_tools` and the full `tool_catalog`). A declared integration is " +
          "optional unless `required: true`.",
        additionalProperties: true,
      },
      output: {
        type: "object",
        description: "Exact AFPS output contract override, including a deterministic JSON schema.",
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  },
  prompt: {
    type: "string",
    description:
      "REQUIRED for kind:inline. The inline run's system prompt, as a top-level argument " +
      "alongside `manifest` (never nested inside it). Tell the run to call the `log` tool " +
      "to report each meaningful step whenever it is selected — the chat shows only those " +
      "lines, live.",
  },
  context_files: {
    type: "array",
    items: { type: "string" },
    description:
      "kind:inline ONLY. `appfile://` URIs only (an `upload://` one goes in a declared file " +
      "field of `input`) — typically straight from a previous run's " +
      "`files` result — mounted read-only into this run's `files/` directory and " +
      "listed in its prompt. This is how you chain runs: to give a run the output of " +
      "earlier runs, pass their `appfile://` URIs here VERBATIM. Never copy a previous " +
      "run's content into `prompt`: re-typing it costs tokens twice, and every URL, figure " +
      "and date you retype is one you can get wrong — the file itself cannot be. No " +
      "manifest change is needed; the platform declares the input field for you. Naming a " +
      "URI in `prompt` mounts nothing: a prompt naming a file the input does not mount is " +
      "refused (400). For " +
      "kind:agent this argument is rejected — a published agent's input schema is a " +
      "versioned contract, so pass the URI through one of its declared file fields instead.",
  },
};

function buildRunAndWaitTool(ctx: McpToolContext, inline: boolean): AppstrateToolDefinition {
  // The route is the gate; this only decides what the model is told.
  // Inline-only descriptor spans are absent, not contradicted, for a caller
  // who cannot launch one.
  const descriptor: Tool = {
    name: "run_and_wait",
    description:
      "Launch a run and wait for its final status in one call: starts " +
      (inline
        ? 'an agent run (`kind:"agent"`, by `scope`/`name`) or an inline run (`kind:"inline"`, ' +
          "by `manifest`+`prompt`)"
        : 'a run of an existing agent (`kind:"agent"`, by `scope`/`name`)') +
      ", exposes the created run to chat for live progress, then returns " +
      "`{ id, packageId, status, done:true, result?, error?, warnings, files?" +
      (ctx.orgSpaces ? ", space" : "") +
      " }` when the run reaches a terminal status; `error` is the run's own failure" +
      (ctx.orgSpaces ? " and `space` the space it ran in" : "") +
      ". `warnings` (`[]` when none) lists the " +
      "integrations the run started without, each with the code that state raises as an error " +
      `on a required integration (${WARNING_CODES_PHRASE}; ` +
      "`integration_unbound` alone: a pin or override bound none). If its wait ends first, it " +
      `returns \`done:false\` with the run \`id\`. ${RUN_AND_WAIT_RESUME_INSTRUCTION} ` +
      "After `done:true`, do NOT call `getRun` to wait; the run is over. " +
      "File deliverables: every file the run writes under its workspace `outputs/` directory is " +
      "published as a file when the run ends and returned here as a `resource_link`" +
      (inline
        ? " — when the " +
          "goal is a downloadable file (report, CSV, image…), instruct the run's `prompt` to write it " +
          "into `outputs/` with a descriptive, task-specific filename that remains understandable " +
          `outside this run; never use context-free names such as ${CONTEXT_FREE_FILENAMES_PHRASE}. ` +
          "For several files or an executable package, instruct the run to build a `.zip` or `.afps` " +
          "archive with its normal shell tools, then publish that single archive with " +
          "`publish_file`. "
        : ". ") +
      "Content merely returned in the output payload never becomes a file." +
      (inline
        ? " Chaining runs (kind:inline): feed earlier runs' deliverables to a later one by passing " +
          "their `appfile://` URIs in `context_files` — never by copying their content into " +
          "`prompt`. " +
          "Prefer an existing agent over an inline manifest when one matches the intent."
        : ""),
    annotations: {
      title: "Run and wait",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: inline ? ["agent", "inline"] : ["agent"],
          description: inline
            ? "`agent` runs a published/draft agent by scope+name; `inline` runs a manifest."
            : "`agent` runs a published/draft agent by scope+name.",
        },
        scope: { type: "string", description: "Agent scope, keep the leading `@` (kind:agent)." },
        name: { type: "string", description: "Agent name (kind:agent)." },
        version: {
          type: "string",
          description:
            "Agent version selector (kind:agent). Omit to run the latest PUBLISHED version — " +
            "404 `no_published_version` when the agent has none. `draft` runs the author's " +
            "working copy and is reserved to callers who may write the agent " +
            "(403 `draft_not_writable` otherwise).",
        },
        input: {
          type: "object",
          description:
            "Run input, validated against the agent's input schema" +
            (inline ? " (either kind — for kind:inline, against `manifest.input.schema`)" : "") +
            ". File fields (typed `format: uri` " +
            "with a `contentMediaType`) accept `appfile://` and `upload://` URIs directly — " +
            "pass an attached file's `appfile://` URI verbatim and the file is streamed " +
            "into the run's workspace.",
          additionalProperties: true,
        },
        ...(inline ? INLINE_ONLY_RUN_AND_WAIT_PROPERTIES : {}),
        wait: {
          type: "integer",
          minimum: 0,
          description:
            "Seconds this call waits for the run to end, launch included: " +
            `${RUN_AND_WAIT_DEFAULT_WAIT_SECONDS} when omitted, at most ` +
            `${RUN_AND_WAIT_MAX_WAIT_SECONDS} (a larger value is clamped to it); \`0\` returns ` +
            "right after the launch. Set it only when you know your client keeps a tool call " +
            "open longer than the default. When the wait ends first, the call returns " +
            "`done:false` and the run goes on.",
        },
        connection_overrides: {
          type: "object",
          additionalProperties: connectionIdSetJsonSchema,
          description:
            "Which connections to use per integration" +
            (inline ? " (either kind)" : "") +
            " — set it when the request names a connection, resolving its id from `get_me`'s " +
            "`connections` before launching" +
            ': `{ "@scope/integration": ' +
            `["<connection_id>", ...] }\`, 0 to ${MAX_CONNECTIONS_PER_INTEGRATION} connection ids per ` +
            "integration — always an ARRAY, even for a single one (a bare string is a 400). " +
            "`[]` runs without that integration — only for one the agent does not mark " +
            "`required` (`required_integration_unbound` otherwise, unless an admin imposes a set, " +
            "where `[]` adds nothing). Connections an admin imposes on an integration stay " +
            "bound whatever is passed: here the map only adds to them, and a connection outside " +
            "an imposed set that allows no additions is a `409 override_outranked`. " +
            "Naming several binds them all: the run's tools then take a " +
            "required `connection` argument carrying the connection's label. This is also the " +
            "retry path for a `409 must_choose_connection` launch error — that error lists the " +
            "integration and its `candidate_connections`, each with a `label`, an " +
            "`account_id`, `owned_by_actor`, `needs_reconnection`, `scopes_granted` and " +
            "`missing_scopes`; pick the candidates the task needs — never one with " +
            "`needs_reconnection: true` or a non-empty `missing_scopes`, the run fails on it — and " +
            "retry the SAME call with their `id`s here. Those fields are what tells the candidates " +
            "apart, so read them rather than listing connections separately. Each key is the " +
            "integration id itself (`@scope/integration`) — NOT the " +
            "`integrations.<id>` field path the error reports it under. A key naming an " +
            "integration the agent does not declare is refused (400). TOP-LEVEL argument, " +
            (inline ? "alongside `manifest`/`input`" : "alongside `input`") +
            " — pass the object itself; JSON-encoding it is " +
            "refused before the launch.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    outputSchema: getRunAndWaitOutputSchema(),
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    const signal = extra.signal;
    throwIfAborted(signal);
    // `launchRunAndWait` validates `kind`; only the inline grant is decided here.
    if (args.kind === "inline" && !inline) {
      emit(ctx, {
        tool: "run_and_wait",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult({
        code: "invalid_argument",
        error: "`kind` must be 'agent'.",
        arguments: ["kind"],
        accepted: ["agent"],
      });
    }

    // `wait` is this tool's own argument; the launch reads every other one.
    const { wait, ...launchArgs } = args;
    const waitSeconds =
      wait === undefined
        ? RUN_AND_WAIT_DEFAULT_WAIT_SECONDS
        : typeof wait === "number" && Number.isInteger(wait) && wait >= 0
          ? Math.min(wait, RUN_AND_WAIT_MAX_WAIT_SECONDS)
          : null;
    if (waitSeconds === null) {
      emit(ctx, {
        tool: "run_and_wait",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult({
        code: "invalid_argument",
        error: "`wait` must be a non-negative integer number of seconds.",
        arguments: ["wait"],
      });
    }

    // Trusted in-process dispatch: forward the caller's auth + the self-dispatch
    // marker (same as invoke_operation), and route the launch and poll fetches
    // back through the platform app. `launchRunAndWait` (shared with the chat
    // paths) owns the launch body construction + validation for both kinds.
    const forwarded = dispatchHeaders(ctx.authHeaders);
    const dispatchFetch = ((input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      return ctx.dispatch(request);
    }) as typeof fetch;

    const launched = await launchRunAndWait(launchArgs, {
      origin: ctx.origin,
      headers: forwarded,
      fetch: dispatchFetch,
      signal,
      // The external MCP surface hands the link to the human driving its
      // client (see `RUN_CONNECT_OFFERS_HEADER`). One thing that is NOT obvious
      // from there: an agent run configured with the Appstrate MCP integration
      // comes through here too, and persists tool results as run events
      // readable with `runs:read-all`. Not a new exposure class —
      // `initiateIntegrationConnect` already returns a bearer `connect_url` on
      // this very path — but any change to how these links are scoped or
      // expired has to account for run logs, not only IDE transcripts. Only the
      // 409 keeps its links: a started run's `warnings` lose theirs (below).
      connectOffers: true,
    });
    // Success or failure, the result names the space it was launched in.
    const space = ctx.orgSpaces ? { space: spaceRef(ctx.orgSpaces.current) } : {};
    if (!launched.ok) {
      // A payload carrying a numeric `status` reached the route: it rejected the
      // request (bad input, unconnected integration, no published version, …) or
      // answered without a run id — reported as an `invoked` POST. A pre-dispatch
      // validation failure (payload carries its `code`, `error` and `arguments`)
      // never touched the route.
      const launchStatus = launched.step.payload.status;
      emit(ctx, {
        tool: "run_and_wait",
        durationMs: performance.now() - start,
        ...(typeof launchStatus === "number"
          ? { method: "POST", status: launchStatus, outcome: "invoked" as const }
          : { outcome: "rejected" as const }),
      });
      const payload = launched.step.payload;
      const projected = projectActiveInSpaces(payload.body, () =>
        (ctx.orgSpaces?.reachable ?? []).filter((s) =>
          args.kind === "inline" ? s.surface.composes : s.surface.runs,
        ),
      );
      return jsonResult({ ...payload, ...(projected && { body: projected.body }), ...space }, true);
    }

    // Any caller of this handler (an agent run included) may persist what it returns; the
    // in-app chat launches through its own extension instead. A mint writes nothing, so the
    // stripped links leave nothing behind.
    const launch = withoutWarningOffers(launched.launch);
    const runId = launch.runId;
    emit(ctx, {
      tool: "run_and_wait",
      durationMs: performance.now() - start,
      operationId: args.kind === "agent" ? "runAgent" : "runInline",
      status: launched.launchStatus,
      outcome: "invoked",
    });

    const stopProgress = startRunProgress(ctx, extra, runId);
    const waitOpts = {
      origin: ctx.origin,
      headers: forwarded,
      fetch: dispatchFetch,
      signal,
    };
    const waited = await waitForRunAndWaitCompletion(launch, {
      ...waitOpts,
      maxMs: waitSeconds * 1000,
    }).then(
      (result) => {
        stopProgress?.(true);
        return result;
      },
      (err: unknown) => {
        stopProgress?.(false);
        throw err;
      },
    );

    // A failed poll reports its HTTP status; otherwise the run's own status (the
    // wait may have ended on `pending`/`running`), not the polling GET's 200.
    const waitedStatus = waited.payload.status;
    emit(ctx, {
      tool: "run_and_wait",
      durationMs: performance.now() - start,
      outcome: "invoked",
      ...(typeof waitedStatus === "number"
        ? { operationId: "getRun", method: "GET", status: waitedStatus }
        : { runStatus: String(waitedStatus) }),
    });

    const { step: final, files } = await enrichTerminalRunAndWaitStep(waited, waitOpts);
    const result = jsonResult({ ...final.payload, ...space }, final.isError);
    // Each published file is also an MCP `resource_link` block (spec 2025-06-18), read with
    // `resources/read` or chained by URI; a run still going gets its next step as text.
    const blocks =
      final.payload.done === false
        ? [{ type: "text" as const, text: RUN_AND_WAIT_LONG_POLL_RESUME }]
        : files.map(fileResourceLink);
    return blocks.length > 0 ? { ...result, content: [...result.content, ...blocks] } : result;
  };

  return { descriptor, handler };
}

function withoutWarningOffers(launch: RunAndWaitLaunch): RunAndWaitLaunch {
  const strip = (record: Record<string, unknown>) =>
    Array.isArray(record.warnings)
      ? { ...record, warnings: withoutConnectOffers(record.warnings as ResolutionFieldError[]) }
      : record;
  return {
    ...launch,
    launchRecord: strip(launch.launchRecord),
    preliminary: strip(launch.preliminary),
  };
}

// --- list_files --------------------------------------------------------

const DEFAULT_FILE_LIST_LIMIT = 20;
const MAX_FILE_LIST_LIMIT = 100;

/** Dispatch an in-process GET, forwarding the caller's auth + trusted marker. */
function dispatchGet(ctx: McpToolContext, url: URL): Promise<Response> {
  return ctx.dispatch(
    new Request(url.toString(), { method: "GET", headers: dispatchHeaders(ctx.authHeaders) }),
  );
}

/** Project a `FileDto` onto the compact row the list tool returns. */
function projectFileRow(raw: unknown): Record<string, unknown> | null {
  const r = asRecord(raw);
  const id = asString(r?.id);
  const uri = asString(r?.uri);
  const name = asString(r?.name);
  if (!id || !uri || !name) return null;
  return {
    id,
    uri,
    name,
    mime: asString(r?.mime) ?? "application/octet-stream",
    size: typeof r?.size === "number" ? r.size : 0,
    // Casing mirrors FileDto (CASING_CONVENTIONS.md 4b): `runId`/`packageId`/
    // `createdAt` are camelCase carve-outs.
    runId: asString(r?.runId) ?? null,
    packageId: asString(r?.packageId) ?? null,
    createdAt: asString(r?.createdAt) ?? null,
    // Surface the same access capabilities the REST DTO carries (computed by the
    // one `getFileCapabilities`), so the model can tell before a
    // `resources/read` whether it will get bytes (`downloadable`) or an opaque
    // reference (`capabilities.metadata` false).
    downloadable: r?.downloadable === true,
    capabilities: asRecord(r?.capabilities) ?? null,
  };
}

function buildListFilesTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "list_files",
    description:
      "List the files visible to you — files you attached to this conversation " +
      "(`user_upload`) and deliverables agents published from runs (`agent_output`). Filter by " +
      "`runId`, `chat_session_id`, or `purpose`. Each row carries an `appfile://` URI you can " +
      "pass verbatim into a run_and_wait input file field (to feed a file to another agent) " +
      "or read with read. Returns `{ files: [...], hasMore }`.",
    annotations: {
      title: "List files",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          description: "Only files produced by / attached to this run.",
        },
        chat_session_id: {
          type: "string",
          description: "Only files attached to this chat session.",
        },
        purpose: {
          type: "string",
          enum: [...filePurposeValues],
          description: "`user_upload` = files you attached; `agent_output` = agent deliverables.",
        },
        limit: {
          type: "integer",
          description: `Max results (default ${DEFAULT_FILE_LIST_LIMIT}, max ${MAX_FILE_LIST_LIMIT}).`,
          minimum: 1,
          maximum: MAX_FILE_LIST_LIMIT,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const query: Record<string, unknown> = {};
    const runId = asString(args.runId);
    if (runId) query.runId = runId;
    const chatSessionId = asString(args.chat_session_id);
    if (chatSessionId) query.chat_session_id = chatSessionId;
    const purpose = asString(args.purpose);
    if (purpose === "user_upload" || purpose === "agent_output") query.purpose = purpose;
    if (typeof args.limit === "number") {
      query.limit = Math.min(Math.max(1, Math.floor(args.limit)), MAX_FILE_LIST_LIMIT);
    }

    const url = new URL("/api/files", ctx.origin);
    applyQuery(url, query);
    const response = await dispatchGet(ctx, url);
    // Reuse container-inherited ACL + scope resolution of the REST route; on any
    // non-2xx surface it verbatim so the model sees the real error.
    if (!response.ok) {
      emit(ctx, { tool: "list_files", durationMs: performance.now() - start });
      return readResponse(response);
    }
    const body = asRecord(await response.json().catch(() => undefined));
    const data = Array.isArray(body?.data) ? body.data : [];
    const files = data.map(projectFileRow).filter((d): d is Record<string, unknown> => d !== null);

    emit(ctx, {
      tool: "list_files",
      durationMs: performance.now() - start,
      shownCount: files.length,
    });
    return jsonResult({ files, hasMore: body?.hasMore === true });
  };

  return { descriptor, handler };
}

function buildReadTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "read",
    description:
      "Read a resource by its URI: an `appfile://` file (from list_files, a run's output or an " +
      "attachment) through the file's own ACL, or a skill file by its `skill://` URI (from " +
      "search or describe of a skill), the same bytes `resources/read` " +
      "serves. A skill's `SKILL.md` is at its `uri`; each of its other files is a " +
      "`resources[].uri` of its entry (describe, or `skills/get`). Small text and binary files are returned " +
      "as embedded MCP resources; an oversized or non-downloadable file returns " +
      "capability-aware metadata.",
    annotations: {
      title: "Read resource",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: {
          type: "string",
          description: "An `appfile://` or `skill://` URI, verbatim as a tool returned it.",
        },
      },
    },
  };

  const readFile = buildFileResourceReader(ctx).read;
  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const uri = asString(args.uri);
    if (!uri) {
      return refusalResult({
        code: "missing_argument",
        error: "uri is required.",
        arguments: ["uri"],
      });
    }
    try {
      const result = uri.startsWith(SKILL_URI_PREFIX)
        ? await readSkillResource(ctx, uri)
        : await readFile(uri);
      return {
        content: result.contents.map((resource) => ({ type: "resource", resource })),
        isError: false,
      } as CallToolResult;
    } catch (err) {
      if (err instanceof ToolRefusal) return refusalResult(err.refusal);
      throw err;
    }
  };
  return { descriptor, handler };
}

/**
 * A `skill://` read through the Skills extension's reader, its JSON-RPC errors as the refusals a
 * tool result carries: an unknown or unreadable URI is `not_found`, a malformed one
 * `invalid_argument`.
 */
async function readSkillResource(ctx: McpToolContext, uri: string): Promise<ReadResourceResult> {
  const mismatch = skillSpaceRefusal(uri, ctx.scope.spaceId, "uri");
  if (mismatch) throw new ToolRefusal(mismatch);
  try {
    return await ctx.skills.read(uri);
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    throw new ToolRefusal({
      code: err.code === RESOURCE_NOT_FOUND_ERROR_CODE ? "not_found" : "invalid_argument",
      error:
        err.code === RESOURCE_NOT_FOUND_ERROR_CODE ? `Skill file not found: ${uri}` : err.message,
      arguments: ["uri"],
    });
  }
}

// --- resources/read for appfile:// ----------------------------------------

/**
 * The file read shared by `read` and `resources/read`, through the files
 * service's container ACL in the file's own space (`resolveFileAcrossSpaces`) and straight
 * from storage (`readStoredFileBytes`, so no presigned redirect to follow). A bad
 * or unknown URI throws a {@link ToolRefusal}; each caller maps it.
 *
 * Returns, each under ~1 MB: `text` for a textual file up to
 * {@link RESOURCE_TEXT_MAX_BYTES}, base64 `blob` for another up to
 * {@link RESOURCE_BLOB_MAX_BYTES}, else metadata-only JSON (also when the caller
 * may not download it), degraded per the caller's {@link FileCapabilities}.
 */
function buildFileResourceReader(ctx: McpToolContext): {
  read: (uri: string) => Promise<ReadResourceResult>;
} {
  /** Metadata-only JSON block — degraded per the caller's capabilities. */
  const metadataOnly = (
    docId: string,
    uri: string,
    row: { size: number; name: string; mime: string; sha256: string },
    caps: FileCapabilities,
    note: string,
  ): ReadResourceResult => {
    const view = projectFileMetadata(row, caps);
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            id: docId,
            uri,
            name: view.name,
            mime: view.mime,
            ...(view.sha256 !== undefined ? { sha256: view.sha256 } : {}),
            size: row.size,
            downloadable: caps.download,
            capabilities: caps,
            ...(caps.download ? { content_url: `${ctx.origin}/api/files/${docId}/content` } : {}),
            note,
          }),
        },
      ],
    };
  };

  return {
    read: async (uri: string): Promise<ReadResourceResult> => {
      const docId = parseFileUri(uri);
      if (!docId) {
        throw new ToolRefusal({
          code: "invalid_argument",
          error: `Not a file resource URI: ${uri}`,
          arguments: ["uri"],
        });
      }

      // `files:read` is asked in the file's own space, which may be another reached space or,
      // for the issuing conversation's upload, the personal space.
      const resolved = await resolveFileAcrossSpaces(
        ctx.scope.orgId,
        ctx.actor,
        docId,
        await ctx.fileAccess(),
      );
      if (!resolved) {
        throw new ToolRefusal({
          code: "not_found",
          error: `File not found: ${uri}`,
          arguments: ["uri"],
        });
      }
      const { row, capabilities } = resolved;
      // Canonicalise the URI to the resolved id (the caller may have passed any
      // valid form) so the returned `contents[].uri` is stable.
      const canonicalUri = fileUri(row.id);

      // Not downloadable (e.g. another member's upload): metadata only, degraded.
      if (!capabilities.download) {
        return metadataOnly(
          row.id,
          canonicalUri,
          row,
          capabilities,
          "Content is not downloadable by you; only its metadata is available.",
        );
      }

      // Downloadable → serve the bytes from storage directly (no 307 to follow).
      const textFile = isTextShapedMime(normalizeMime(row.mime));
      if (row.size <= (textFile ? RESOURCE_TEXT_MAX_BYTES : RESOURCE_BLOB_MAX_BYTES)) {
        const bytes = await readStoredFileBytes(row);
        if (bytes) {
          const content = textFile
            ? { text: new TextDecoder().decode(bytes) }
            : { blob: Buffer.from(bytes).toString("base64") };
          return {
            contents: [
              {
                uri: canonicalUri,
                mimeType: row.mime,
                ...content,
                _meta: { [FILE_NAME_META_KEY]: row.name },
              },
            ],
          };
        }
      }

      // Oversized (either kind), or the storage object went missing → metadata.
      return metadataOnly(
        row.id,
        canonicalUri,
        row,
        capabilities,
        `${RESOURCE_OVERSIZED_NOTE} Fetch it from the content_url.`,
      );
    },
  };
}

/** JSON-RPC code for an unknown resource (MCP 2025-11-25, resources "Error Handling"). */
export const RESOURCE_NOT_FOUND_ERROR_CODE = -32002;

/**
 * `resources/read` for `appfile://` URIs: a refusal is a JSON-RPC error here, as
 * the resource protocol has no tool-result channel. A file that does not
 * resolve is `-32002`; a malformed URI is `-32602`. No `list()`: files surface
 * only via `resource_link`, so `resources/list` is empty.
 */
export function buildFileResourceProvider(ctx: McpToolContext): AppstrateResourceProvider {
  const reader = buildFileResourceReader(ctx);
  return {
    read: (uri: string) =>
      reader.read(uri).catch((err: unknown) => {
        if (!(err instanceof ToolRefusal)) throw err;
        const { code, error } = err.refusal;
        throw new McpError(
          code === "not_found" ? RESOURCE_NOT_FOUND_ERROR_CODE : ErrorCode.InvalidParams,
          error,
          { uri },
        );
      }),
  };
}

function buildGetMeTool(ctx: McpToolContext, surface: McpSurface): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "get_me",
    description:
      "Return the caller's working context in the space of the call: `user`, `org` (with the " +
      "organization `role`), `space`, `connections`, `agents`, `skills` and `recent_runs`" +
      (ctx.orgSpaces
        ? ", and `spaces`: your role in each space you reach, which, not the organization role, decides each call"
        : "") +
      ". `connections` holds one entry per " +
      "integration with a connection the caller may bind in THIS space, its own or shared into it " +
      "(a connection shared with team spaces is absent from a personal space), each listing those " +
      "`connections` (`id`, `label`, `account_id`, `owned_by_actor`, `needs_reconnection`). On the " +
      "integration entry, not on a connection: `active` (`false`: the integration is switched off " +
      "in this space, so a run there cannot use it until it is activated — `activatePackage`, or " +
      "for an organization owner or admin offered to the organization: from chat, in the " +
      "organization catalog; otherwise `offerPackageToOrg` with an unconfined user credential. An " +
      "offer activates the integration, never a connection, and a space's own switched-off row " +
      "still wins); `via` (`home`, `shared`, `system`, `organization`: why it is placed here, " +
      "`null` when the caller holds a connection but it is not placed); `version` and " +
      "`default_tools`, present only when active; `needs_reconnection` (no healthy connection: " +
      "its owner must reconnect it). " +
      (surface.proxies
        ? "The tools of these integrations are listed by `search` (`integration_tool` kind), with " +
          "those of active integrations that need no connection; active ones that need one and " +
          "lack a usable connection are listed there under `not_ready`. "
        : surface.proxiesClosed
          ? "You cannot call them directly here: an admin closed this space's credential proxy " +
            "outside a run. Agents you run still use them. "
          : "") +
      "`agents` and `skills` are capped (`agents_truncated`, `skills_truncated`): `search` finds " +
      "the rest by keyword.",
    annotations: {
      title: "Get caller context",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  };

  const handler = async (): Promise<CallToolResult> => {
    const start = performance.now();
    // Trusted in-process re-entry — same rationale as invoke_operation: lets the
    // org-pinned MCP token reach a space-scoped route, in the space it entered.
    const request = new Request(new URL("/api/me/context", ctx.origin).toString(), {
      method: "GET",
      headers: dispatchHeaders(ctx.authHeaders),
    });
    const response = await ctx.dispatch(request);
    emit(ctx, {
      tool: "get_me",
      durationMs: performance.now() - start,
      method: "GET",
      path: "/api/me/context",
      status: response.status,
      outcome: "invoked",
    });
    const spaces = ctx.orgSpaces?.reachable.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      personal: s.personal,
    }));
    return readResponse(response, spaces ? { spaces } : undefined);
  };

  return { descriptor, handler };
}

/**
 * What one request's caller is offered: the tools `buildMcpTools` declares AND
 * the acts `buildServerInstructions` teaches, each read off the guards of the
 * route it dispatches to (or, for `import_package_file`, stands in for). A
 * withheld act is ABSENT from both — never declared then refused. Org-wide, the
 * surface is the union of the spaces', refused per space by `withSpaceArgument`.
 */
export interface McpSurface {
  /** `invoke_operation`; the transport already required `mcp:read`. */
  invokes: boolean;
  /** `run_and_wait`: launch AND read back — a run nobody can poll still bills. */
  runs: boolean;
  /** `run_and_wait` with `kind:"inline"`. */
  composes: boolean;
  /** Creating an agent through `invoke_operation`. */
  authors: boolean;
  /** May create a package of at least one type (agent, skill or integration). */
  creates: boolean;
  listsFiles: boolean;
  importsPackages: boolean;
  /** `search`'s and `describe`'s integration tools, and `call_integration_tool`: the credential proxy outside a run. */
  proxies: boolean;
  /**
   * The integration tools are withheld by the space's setting alone (`credential_proxy_open`),
   * not by the caller's grants: `get_me` says so, since an undeclared tool explains nothing.
   */
  proxiesClosed: boolean;
}

export function deriveMcpSurface(
  permissions: ReadonlySet<string>,
  ceiling: ReadonlySet<string> | undefined,
  actor: Actor,
  /** The credential proxy accepts the credential this request carries (it is bearer-only). */
  proxyAcceptsCredential: boolean,
  /** The space, whose setting the proxy's access rule reads (`reachOutsideRunIfPermitted`). */
  space: Pick<SpaceContextRow, "credentialProxyOpen">,
): McpSurface {
  const granted = (operationId: string): boolean =>
    operationIdGranted(operationId, permissions, ceiling);
  const invokes = permissions.has("mcp:invoke");
  const runs = invokes && granted("runAgent") && granted("getRun");
  // `credential-proxy:call-own` (implied by `credential-proxy:call`), read off the listing's
  // route, which guards as `/proxy` does. `mcp:invoke` is checked here and nowhere else.
  const mayProxy = invokes && proxyAcceptsCredential && granted("listCredentialProxyConnections");
  const closed = reachOutsideRunIfPermitted(permissions, space) === "closed";
  return {
    invokes,
    runs,
    composes: runs && granted("runInline"),
    authors: invokes && granted("createAgent"),
    creates:
      invokes &&
      (granted("createAgent") || granted("createSkill") || granted("createIntegrationPackage")),
    listsFiles: granted("listFiles"),
    // `import_package_file` calls the import service directly: it re-checks
    // each package's `write`, but `mcp:invoke` and the user actor (the import
    // is recorded under a user id) are checked here and nowhere else.
    importsPackages: invokes && actor.type === "user" && granted("importBundle"),
    proxies: mayProxy && !closed,
    proxiesClosed: mayProxy && closed,
  };
}

/**
 * The SDK does not validate `tools/call` arguments against `inputSchema`, so an
 * argument a tool does not read is dropped in silence — a misspelled filter
 * widens a listing, a misspelled field is simply not applied. A tool declaring
 * `additionalProperties: false` therefore gets its undeclared top-level keys
 * refused here, as an `unknown_argument` refusal naming the accepted ones,
 * before its handler runs.
 */
function refuseUndeclaredArguments(
  tool: AppstrateToolDefinition,
  pinned: boolean,
): AppstrateToolDefinition {
  const schema = tool.descriptor.inputSchema;
  if (schema.additionalProperties !== false) return tool;
  const declared = new Set(Object.keys(schema.properties ?? {}));
  return {
    descriptor: tool.descriptor,
    handler: async (args, extra) => {
      const unknown = Object.keys(args).filter((k) => !declared.has(k));
      if (unknown.length > 0) {
        const accepted =
          declared.size > 0 ? `Accepted: ${[...declared].join(", ")}.` : "No arguments.";
        const pinnedSpace = pinned && unknown.includes("space_id");
        return refusalResult({
          code: "unknown_argument",
          error: `Unknown argument(s): ${unknown.join(", ")}. ${accepted}`,
          arguments: unknown,
          accepted: [...declared],
          ...(pinnedSpace
            ? {
                hint: "This connection is pinned to one space (by its URL or its credential); drop space_id.",
              }
            : {}),
        });
      }
      return tool.handler(args, extra);
    },
  };
}

/**
 * Build the per-request tool set. Handlers close over the caller's auth
 * context.
 *
 * No aliases for retired tool names: a stale client gets `-32602 Unknown tool`
 * and re-lists, where an alias would be a permanent second dispatch path.
 */
export function buildMcpTools(ctx: McpToolContext, surface: McpSurface): AppstrateToolDefinition[] {
  const integrations: IntegrationToolContext = {
    origin: ctx.origin,
    authHeaders: ctx.authHeaders,
    dispatch: ctx.dispatch,
    observe: (event) => emit(ctx, event),
    runs: surface.runs,
  };
  const tools = [
    buildSearchTool(ctx, surface, integrations),
    buildDescribeTool(ctx, surface, integrations),
    ...(surface.invokes ? [buildInvokeTool(ctx)] : []),
    ...(surface.runs ? [buildRunAndWaitTool(ctx, surface.composes)] : []),
    ...(surface.listsFiles ? [buildListFilesTool(ctx)] : []),
    buildReadTool(ctx),
    ...buildPackageFileTools(ctx, surface.importsPackages),
    ...(surface.proxies ? [buildCallIntegrationToolTool(integrations)] : []),
    buildGetMeTool(ctx, surface),
  ];
  const { orgSpaces } = ctx;
  const pinned = orgSpaces === undefined;
  return (orgSpaces ? tools.map((tool) => withSpaceArgument(tool, orgSpaces)) : tools).map((tool) =>
    refuseUndeclaredArguments(tool, pinned),
  );
}

/**
 * What each tool needs in the space an org-wide call names: `false` no space
 * (no `space_id`), `null` the route guard alone, else the surface act
 * re-checked there, `"optional"` the route guard alone and `space_id` may be omitted (the tool
 * then covers every space reached). Exhaustive, so a new tool must decide.
 */
const SPACE_ACTS: Record<McpToolName, keyof McpSurface | null | false | "optional"> = {
  search: "optional",
  describe: null,
  invoke_operation: "invokes",
  run_and_wait: "runs",
  list_files: "listsFiles",
  read: null,
  validate_package_file: null,
  import_package_file: "importsPackages",
  call_integration_tool: "proxies",
  get_me: null,
  get_runtime_capabilities: false,
};

/** `space_id`, listing the spaces itself: clients truncate server instructions. */
function spaceIdProperty(spaces: OrgWideSpaces, optional: boolean): Record<string, unknown> {
  const reached = spaces.reachable.map(describeSpace).join("; ");
  return {
    type: "string",
    enum: spaces.reachable.map((s) => s.id),
    description: optional
      ? `The space to search, by id: ${reached}. Pass it whenever the space is known: omitted, ` +
        "every space you reach is searched (`searched_spaces` lists them; a chat conversation is " +
        "attached to each) and each item's `granted_in` names the spaces where you reach it: act " +
        "on it with one of them, where your role there still decides."
      : `The space this call acts in, by id: ${reached}. Choose it in the order given in the ` +
        "server instructions.",
  };
}

/**
 * The refusal of an act the space an org-wide call entered does not grant the caller, or
 * `undefined`: in the proxy route's order, its permission first (`not_granted`), then the space's
 * barrier (`credential_proxy_closed`), met only by a caller the permission admits. `what` names
 * the act in the refusal.
 */
function spaceActRefusal(
  spaces: OrgWideSpaces,
  need: keyof McpSurface | null,
  what: string,
): Refusal | undefined {
  const holds = (space: McpSpace) => need === null || space.surface[need];
  const { current } = spaces;
  if (need === "proxies" && current.surface.proxiesClosed) {
    return {
      code: "credential_proxy_closed",
      error: credentialProxyClosedDetail(current),
      space: spaceRef(current),
      ...grantedIn(spaces, holds),
      hint: NO_FALLBACK_HINT,
    };
  }
  if (holds(current)) return undefined;
  return {
    code: "not_granted",
    error: `Your role in ${describeSpace(current)} does not allow ${what}.`,
    space: spaceRef(current),
    ...grantedIn(spaces, holds),
    hint: NO_FALLBACK_HINT,
  };
}

/** Declare `space_id` on a space-acting tool and check it before the handler runs. */
function withSpaceArgument(
  tool: AppstrateToolDefinition,
  spaces: OrgWideSpaces,
): AppstrateToolDefinition {
  const declared = SPACE_ACTS[tool.descriptor.name as McpToolName];
  if (declared === false) return tool;
  const optional = declared === "optional";
  const act = optional ? null : declared;
  const holds = (need: keyof McpSurface | null) => (space: McpSpace) =>
    need === null || space.surface[need];
  const granted = grantedSpaces(spaces, holds(act));
  const schema = tool.descriptor.inputSchema;
  const descriptor: Tool = {
    ...tool.descriptor,
    // Leading: clients cap long descriptions, and this is the part that varies.
    description: granted
      ? `Available in: ${granted.map(describeSpace).join("; ")}. ${tool.descriptor.description}`
      : tool.descriptor.description,
    inputSchema: {
      ...schema,
      properties: { ...schema.properties, space_id: spaceIdProperty(spaces, optional) },
      ...(optional ? {} : { required: [...(schema.required ?? []), "space_id"] }),
    },
  };
  return {
    descriptor,
    handler: async (args, extra) => {
      // The tool reads `space_id` itself: absent, it covers every space reached.
      if (optional && args.space_id === undefined) return tool.handler(args, extra);
      const refusal = spaceArgumentRefusal(spaces, args.space_id);
      if (refusal) return refusalResult(refusal);
      if (optional) return tool.handler(args, extra);
      // `kind:"inline"` is the `composes` act, a narrower grant than `runs`.
      const need = act === "runs" && args.kind === "inline" ? "composes" : act;
      const unmet = spaceActRefusal(
        spaces,
        need,
        `${tool.descriptor.name}${need === "composes" ? ' with kind:"inline"' : ""}`,
      );
      if (unmet) return refusalResult(unmet);
      // Consumed: `run_and_wait` validates its own arguments.
      const { space_id: _entered, ...rest } = args;
      return tool.handler(rest, extra);
    },
  };
}
