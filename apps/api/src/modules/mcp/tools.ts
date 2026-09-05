// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP tool surface: a compact progressive-disclosure and workflow layer.
 *
 * The platform exposes ~250 operations. Surfacing them as 250 individual
 * MCP tools would blow past every client's tool-definition budget (50 tools
 * ≈ 72K tokens), so instead we expose a tiny fixed surface and let the model
 * discover on demand:
 *
 *   - `search_operations`   — keyword/tag search over the catalog; a keyword
 *                             hit also returns the top match's full schema as
 *                             `best_match`, so the common single-target case
 *                             skips the separate describe step
 *   - `describe_operation`  — full input schema for one operation
 *   - `invoke_operation`    — execute one operation
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

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  AppstrateRequestExtra,
  AppstrateResourceProvider,
  AppstrateToolDefinition,
  ReadResourceResult,
} from "@appstrate/mcp-transport";
import {
  launchRunAndWait,
  waitForRunAndWaitCompletion,
  fetchRunFiles,
  type RunAndWaitFile,
} from "@appstrate/core/run-and-wait-client";
import { parseFileUri, fileUri } from "@appstrate/core/file-uri";
import { CONTEXT_FREE_FILENAMES_PHRASE } from "@appstrate/afps-runtime/bundle";
import type { Actor } from "@appstrate/connect";
import { getCatalog, collectReferencedSchemas, type CatalogOperation } from "./catalog.ts";
import { internalDispatchHeader } from "../../lib/internal-dispatch.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import {
  getFileForActor,
  streamFileContent,
  projectFileMetadata,
  type FileCapabilities,
} from "../../services/files.ts";
import { isTextShapedMime, normalizeMime } from "../../services/mime-policy.ts";
import { isTextShapedContentType } from "@appstrate/core/mime";
import { asString, textResult } from "./tool-results.ts";
import { buildPackageFileTools } from "./package-file-tools.ts";

/** Issue an in-process request back through the platform app. */
export type Dispatch = (req: Request) => Promise<Response>;

/** The tools, named for telemetry/audit. */
export type McpToolName =
  | "search_operations"
  | "describe_operation"
  | "invoke_operation"
  | "run_and_wait"
  | "list_files"
  | "read_file"
  | "validate_package_file"
  | "import_package_file"
  | "get_runtime_capabilities"
  | "get_me";

/** Outcome of an `invoke_operation` call, for audit + telemetry. */
export type McpInvokeOutcome =
  /** Caller lacks `mcp:invoke` — no dispatch happened (security-relevant). */
  | "denied"
  /** Client error before dispatch (unknown operationId, missing path params). */
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
  /** `search_operations`: number of matches returned. */
  resultCount?: number;
  /** `invoke_operation`: which operation, its method/path, and the outcome. */
  operationId?: string;
  method?: string;
  path?: string;
  status?: number;
  outcome?: McpInvokeOutcome;
}

export type McpObserver = (event: McpToolEvent) => void;

export interface McpToolContext {
  /** Origin of the inbound `/mcp` request, e.g. `https://instance.example`. */
  origin: string;
  /** Auth-relevant headers forwarded onto dispatched requests. */
  authHeaders: Headers;
  /** Effective permissions of the caller (from the session/token). */
  permissions: ReadonlySet<string>;
  /**
   * The resolved caller identity (from the same forwarded auth the dispatched
   * requests carry). Lets the file resource provider call the files
   * service DIRECTLY — no in-process HTTP round-trip, so it works identically
   * across FS / S3-proxy / S3-presigned storage (the 307-redirect a fetch
   * cannot follow no longer degrades the read).
   */
  actor: Actor;
  /** The caller's org+space scope (org fixed by the endpoint/token; space resolved). */
  scope: SpaceScope;
  authorizeBundle?: Parameters<typeof buildPackageFileTools>[0]["authorizeBundle"];
  /** In-process dispatcher (defaults to the platform app at request time). */
  dispatch: Dispatch;
  /**
   * Optional sink for audit + telemetry events. Defaults to a no-op so unit
   * tests and any non-HTTP caller need not provide one.
   */
  observe?: McpObserver;
  /**
   * The caller already injects the get_me payload (`GET /api/me/context`) into
   * its own system prompt, so the redundant get_me tool is dropped. Only the
   * in-process chat consumer sets this (it injects that block + carries the
   * server instructions); external MCP clients leave it false and keep get_me.
   */
  contextInjected?: boolean;
}

/** Never let an observer error affect the tool result. */
function emit(ctx: McpToolContext, event: McpToolEvent): void {
  try {
    ctx.observe?.(event);
  } catch {
    // Telemetry/audit is best-effort; swallow.
  }
}

const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;
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
  "x-space-id",
  "appstrate-user",
  "appstrate-version",
] as const;
// Headers the caller may NOT set via the `headers` arg: the auth context is
// forwarded from the inbound MCP request and must not be reshaped by the
// model (no swapping credentials, switching org/space, or forging end-user
// impersonation). Everything else (e.g. Credential-Proxy target headers) is
// allowed — still bounded by RBAC on the dispatched route. The forwarded auth
// set plus the hop-by-hop headers we set ourselves (`host`, `content-length`)
// and the internal self-dispatch marker: that marker is set by THIS layer (see
// the dispatch request build below) and exempts the request from outbound
// resource-audience confinement — a client-supplied value would be a forgery
// attempt, dropped here so only our authoritative, nonce-valued header survives.
// (Even without this, the value must equal an unguessable per-process secret, so
// a forgery cannot succeed; this is defence in depth.)
const PROTECTED_HEADERS = new Set<string>([
  ...FORWARDED_AUTH_HEADERS,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// --- files (resource_link + resources/read + list_files) -----------
// The `appfile://` URI prefix, id shape, and parser are the canonical,
// dependency-free helpers from `@appstrate/core/file-uri` (imported above)
// — the tool layer stays free of the files service's DB/storage graph
// while sharing one contract.

/**
 * Ceiling on inlining a file's bytes into a `resources/read` text block.
 * Above it (or for a non-textual mime) the read returns metadata only — MCP has
 * no partial-content standard, so we keep it simple.
 */
const RESOURCE_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on inlining a NON-textual file's RAW bytes as a base64 `blob` in a
 * `resources/read` result. Base64 inflates 4/3, so a 700 KiB raw cap keeps the
 * encoded payload (~933 KiB) under the ~1 MB practical MCP response limit. Above
 * it (either kind) the read returns metadata only.
 */
const RESOURCE_BLOB_MAX_BYTES = 700 * 1024;

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
    description: `File published by this run — read it with read_file or pass its URI to a follow-up run_and_wait input file field.`,
  };
}

/**
 * Map a run's terminal status to an HTTP-shaped code for telemetry, so a
 * failed / timed-out / cancelled run is reported distinctly rather than always
 * as 200 (the polling GET's status).
 */
function runStatusToHttp(status: unknown): number {
  switch (status) {
    case "success":
      return 200;
    case "failed":
      return 500;
    case "timeout":
      return 504;
    case "cancelled":
      return 499;
    default:
      return 200;
  }
}

function scoreOperation(op: CatalogOperation, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack =
    `${op.operationId} ${op.summary} ${op.description} ${op.pathTemplate} ${op.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

/**
 * The full, invoke-ready definition of one operation: parameters, request body,
 * responses, and every referenced component schema inlined. This is the payload
 * `describe_operation` returns, and it is also embedded as `search_operations`'
 * `best_match` so a clear single-hit search needs no follow-up describe call.
 */
function describePayload(
  op: CatalogOperation,
  componentSchemas: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operation_id: op.operationId,
    method: op.method,
    path: op.pathTemplate,
    path_params: op.pathParams,
    summary: op.summary,
    description: op.description,
    parameters: op.operation.parameters ?? [],
    request_body: op.operation.requestBody ?? null,
    responses: op.operation.responses ?? {},
    referenced_schemas: collectReferencedSchemas(op.operation, componentSchemas),
  };
}

function buildSearchTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "search_operations",
    description:
      "Search the Appstrate API for operations by keyword and/or tag. Returns matching " +
      "operationIds with their HTTP method, path, and summary. Use this first to discover " +
      "which operation to call. For a keyword search, the response also includes a " +
      "`best_match` carrying the top result's full input schema — when it matches your " +
      "intent you can call invoke_operation directly, no describe_operation needed.",
    annotations: {
      title: "Search API operations",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text keywords matched against id/summary/path/tags.",
        },
        tag: { type: "string", description: "Restrict to a single OpenAPI tag (e.g. 'Agents')." },
        limit: {
          type: "integer",
          description: `Max results (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`,
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
        },
      },
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const { operations, componentSchemas } = getCatalog();
    const query = asString(args.query)?.trim().toLowerCase() ?? "";
    const tag = asString(args.tag)?.toLowerCase();
    const rawLimit = typeof args.limit === "number" ? args.limit : DEFAULT_SEARCH_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_SEARCH_LIMIT);
    const tokens = query.split(/\s+/).filter(Boolean);

    let matches = [...operations.values()];
    if (tag) matches = matches.filter((op) => op.tags.some((t) => t.toLowerCase() === tag));

    const scored = matches
      .map((op) => ({ op, score: scoreOperation(op, tokens) }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.op.operationId.localeCompare(b.op.operationId))
      .slice(0, limit);

    emit(ctx, {
      tool: "search_operations",
      durationMs: performance.now() - start,
      resultCount: scored.length,
    });

    // For a keyword search with at least one hit, embed the top match's full
    // invoke-ready definition so the common single-target case needs no
    // follow-up describe_operation call. Only the top result carries the
    // schema, to keep the response bounded; the rest stay compact.
    const top = scored[0];
    const bestMatch =
      tokens.length > 0 && top ? describePayload(top.op, componentSchemas) : undefined;

    return textResult({
      count: scored.length,
      total: matches.length,
      operations: scored.map(({ op }) => ({
        operation_id: op.operationId,
        method: op.method,
        path: op.pathTemplate,
        summary: op.summary,
        tags: op.tags,
      })),
      best_match: bestMatch,
    });
  };

  return { descriptor, handler };
}

function buildDescribeTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "describe_operation",
    description:
      "Return the full OpenAPI definition for one operation (parameters, request body, " +
      "responses) with all referenced component schemas inlined, so you can construct a " +
      "valid invoke_operation call.",
    annotations: {
      title: "Describe API operation",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        operation_id: {
          type: "string",
          description:
            "The operationId, as returned by search_operations (or already known). Not " +
            "needed when search_operations already returned a matching best_match.",
        },
      },
      required: ["operation_id"],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const operationId = asString(args.operation_id);
    // Structural protocol errors (-32602 InvalidParams): a missing required
    // argument or an unknown operationId is a malformed call, not a failed
    // execution — the MCP spec files these under protocol errors. Execution
    // failures (upstream HTTP errors, …) stay `isError` tool results so the
    // model sees them and can self-correct.
    if (!operationId) {
      throw new McpError(ErrorCode.InvalidParams, "operation_id is required.");
    }

    const { operations, componentSchemas } = getCatalog();
    const op = operations.get(operationId);
    if (!op) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown operationId: ${operationId}`);
    }

    emit(ctx, {
      tool: "describe_operation",
      durationMs: performance.now() - start,
      operationId,
    });

    return textResult(describePayload(op, componentSchemas));
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
 */
export async function readResponse(response: Response): Promise<CallToolResult> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const isError = response.status >= 400;

  if (contentType.includes("text/event-stream")) {
    return textResult(
      {
        status: response.status,
        error:
          "This operation streams (text/event-stream) and is not supported via invoke_operation. Consume the realtime/SSE endpoint directly.",
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
    return textResult(
      {
        status: response.status,
        note: "Non-text response body omitted.",
        content_type: contentType,
        bytes: len ? Number(len) : null,
      },
      isError,
    );
  }

  let raw = await response.text();
  let truncated = false;
  if (raw.length > MAX_RESPONSE_CHARS) {
    raw = raw.slice(0, MAX_RESPONSE_CHARS);
    truncated = true;
  }

  let body: unknown = raw;
  if (!truncated && contentType.includes("json") && raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  return textResult(
    { status: response.status, ...(truncated ? { truncated: true } : {}), body },
    isError,
  );
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
      "Execute an Appstrate API operation. Call describe_operation first to learn its " +
      "path_params, query, and body shapes. Runs with your own credentials and permissions; " +
      "the request is validated and authorized exactly as the equivalent REST call.",
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
      properties: {
        operation_id: { type: "string", description: "The operationId to invoke." },
        path_params: {
          type: "object",
          description: "Values for path placeholders (e.g. { scope, name }).",
          additionalProperties: true,
        },
        query: {
          type: "object",
          description: "Query-string parameters.",
          additionalProperties: true,
        },
        body: {
          type: "object",
          description: "JSON request body (for POST/PUT/PATCH).",
          additionalProperties: true,
        },
        headers: {
          type: "object",
          description:
            "Request headers (string values) for operations that declare an 'in: header' " +
            "parameter, e.g. X-Integration-Id for the credential proxy. (Such params are also " +
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

    if (!ctx.permissions.has("mcp:invoke")) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        outcome: "denied",
      });
      return textResult(
        { error: "Permission 'mcp:invoke' is required to invoke operations." },
        true,
      );
    }

    // Structural protocol errors (-32602 InvalidParams): missing required
    // argument / unknown operationId — the call itself is malformed, per the
    // MCP spec's protocol-error taxonomy. The telemetry `rejected` event is
    // still emitted before throwing. Everything past this point (missing
    // path_params, permission denial, upstream HTTP failures) stays a
    // model-visible `isError` tool result for self-correction.
    if (!operationId) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      throw new McpError(ErrorCode.InvalidParams, "operation_id is required.");
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
      throw new McpError(ErrorCode.InvalidParams, `Unknown operationId: ${operationId}`);
    }

    const pathParams = asRecord(args.path_params) ?? {};
    const path = interpolatePath(op, pathParams);
    if (path === null) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        operationId,
        method: op.method,
        outcome: "rejected",
      });
      return textResult(
        { error: `Missing path_params. Required: ${op.pathParams.join(", ")}` },
        true,
      );
    }

    const query = asRecord(args.query) ?? {};

    const headers = new Headers(ctx.authHeaders);
    const extraHeaders = asRecord(args.headers);
    if (extraHeaders) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        if (PROTECTED_HEADERS.has(name.toLowerCase())) continue;
        if (typeof value !== "string") continue;
        // A model-supplied header name/value may be syntactically invalid
        // (`Headers.set` throws a TypeError). Surface a graceful tool error
        // instead of a 500 so the model can self-correct.
        try {
          headers.set(name, value);
        } catch {
          emit(ctx, {
            tool: "invoke_operation",
            durationMs: performance.now() - start,
            operationId,
            method: op.method,
            outcome: "rejected",
          });
          return textResult({ error: `Invalid header name or value: ${name}` }, true);
        }
      }
    }
    // Auto-map OpenAPI `in: header` parameters: a model often supplies a
    // declared header value in `query` (or the operation simply requires a
    // header it can't express otherwise, e.g. the Credential Proxy's
    // X-Integration-Id). For each declared header param not already set,
    // pull its value from `query` (case-insensitive) and move it to a header.
    for (const headerName of op.headerParams) {
      if (PROTECTED_HEADERS.has(headerName.toLowerCase())) continue;
      if (headers.has(headerName)) continue;
      const queryKey = Object.keys(query).find((k) => k.toLowerCase() === headerName.toLowerCase());
      if (queryKey === undefined) continue;
      const value = query[queryKey];
      if (typeof value === "string" || typeof value === "number") {
        headers.set(headerName, String(value));
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
      return textResult({ error: "`body` must be a JSON object." }, true);
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
    return readResponse(response);
  };

  return { descriptor, handler };
}

// --- run_and_wait ----------------------------------------------------------

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Aborted");
}

function buildRunAndWaitTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "run_and_wait",
    description:
      'Launch a run and wait for its final status in one call: starts an agent run (`kind:"agent"`, ' +
      'by `scope`/`name`) or an inline run (`kind:"inline"`, by `manifest`+`prompt`), exposes ' +
      "the created run to chat for live progress, then returns " +
      "`{ id, packageId, status, done:true, result?, error? }` when the run reaches a terminal " +
      "status. Do NOT call `getRun` after this tool just to wait for completion; this tool already " +
      "waits. For an inline run, `manifest` is a PARTIAL canonical AFPS manifest: normally set " +
      "only a concise task-specific `display_name` plus task dependencies/configuration. The " +
      "platform derives `name` and fills omitted AFPS boilerplate, `runtime_tools` (log, output, " +
      "publish_file), and an open object output schema. Defaults apply only " +
      "to fields you omit; " +
      "every field you provide replaces its default exactly, with no array or nested-object merge. " +
      "That includes `runtime_tools: []`, which stays empty and disables every default runtime tool. " +
      "A complete deterministic manifest may override every field, including a strict " +
      "`output.schema`; when it does, its explicit `runtime_tools` must include `output`. The chat " +
      "shows only lines emitted through `log`, so instruct the run to log meaningful steps whenever " +
      "that tool is selected. Never use an id or a generic display name such as `one-shot`. " +
      "File deliverables: every file the run writes under its workspace `outputs/` directory is " +
      "published as a file when the run ends and returned here as a `resource_link` — when the " +
      "goal is a downloadable file (report, CSV, image…), instruct the run's `prompt` to write it " +
      "into `outputs/` with a descriptive, task-specific filename that remains understandable " +
      `outside this run; never use context-free names such as ${CONTEXT_FREE_FILENAMES_PHRASE}. ` +
      "For several files or an executable package, instruct the run to build a `.zip` or `.afps` " +
      "archive with its normal shell tools, then publish that single archive with " +
      "`publish_file`. " +
      "Content merely returned in the output payload never becomes a file. " +
      "Chaining runs (kind:inline): feed earlier runs' deliverables to a later one by passing " +
      "their `appfile://` URIs in `context_files` — never by copying their content into " +
      "`prompt`. " +
      "Prefer an existing agent over an inline manifest when one matches the intent.",
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
          enum: ["agent", "inline"],
          description:
            "`agent` runs a published/draft agent by scope+name; `inline` runs a manifest.",
        },
        scope: { type: "string", description: "Agent scope, keep the leading `@` (kind:agent)." },
        name: { type: "string", description: "Agent name (kind:agent)." },
        version: {
          type: "string",
          description:
            "Agent version selector (kind:agent). Omit for the latest published version; pass " +
            "`draft` to run the working copy of a draft-only agent.",
        },
        input: {
          type: "object",
          description:
            "Run input, validated against the agent's input schema (either kind — for " +
            "kind:inline, against `manifest.input.schema`). File fields (typed `format: uri` " +
            "with a `contentMediaType`) accept `appfile://` and `upload://` URIs directly — " +
            "pass an attached file's `appfile://` URI verbatim and the file is streamed " +
            "into the run's workspace.",
          additionalProperties: true,
        },
        manifest: {
          type: "object",
          description:
            "Partial canonical AFPS agent manifest (kind:inline). Usually only `display_name` " +
            "plus task-specific dependencies/configuration are needed; `name` is derived and " +
            "AFPS boilerplate, runtime tools, and an open output schema are defaulted. Every " +
            "provided field is an exact top-level replacement: arrays and nested objects are not " +
            "merged, and `runtime_tools: []` is preserved. You may instead provide a complete, " +
            "strict deterministic manifest and override every field. Do NOT put the prompt inside " +
            "the manifest — it goes in the separate top-level `prompt` argument.",
          properties: {
            display_name: {
              type: "string",
              description:
                "Task-specific human title. When name is omitted, the platform derives " +
                "@inline/<slug> from this value.",
            },
            name: {
              type: "string",
              description:
                "Optional exact canonical @scope/name override. Usually omit and provide " +
                "display_name.",
            },
            dependencies: {
              type: "object",
              description: "Exact AFPS dependencies override.",
              additionalProperties: true,
            },
            integrations_configuration: {
              type: "object",
              description: "Exact AFPS integration configuration override.",
              additionalProperties: true,
            },
            runtime_tools: {
              type: "array",
              description:
                "Exact runtime-tool selection. Omit for " +
                "log/output/publish_file defaults; " +
                "an explicit [] disables them all.",
              items: { type: "string" },
            },
            output: {
              type: "object",
              description:
                "Exact AFPS output contract override, including a deterministic JSON schema.",
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
            "to report each meaningful step — those lines are what the chat shows live. When the " +
            "run produces files, require descriptive, task-specific names that remain clear " +
            `outside this run; never generic names such as ${CONTEXT_FREE_FILENAMES_PHRASE}.`,
        },
        connection_overrides: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            'Which connection to use per integration (either kind): `{ "@scope/integration": ' +
            '"<connection_id>" }`, exactly one connection id per integration. This is the retry ' +
            "path for a `412 must_choose_connection` launch error — that error lists the " +
            "ambiguous integration and its `candidate_connection_ids`; pick one id from that " +
            "list and retry the SAME call with it here. Each key is the integration id itself " +
            "(`@scope/integration`) — NOT the `integrations.<id>` field path the error reports " +
            "it under, which matches no integration and is ignored. TOP-LEVEL argument, " +
            "alongside `manifest`/`input` — pass the object itself; JSON-encoding it is " +
            "refused before the launch.",
        },
        context_files: {
          type: "array",
          items: { type: "string" },
          description:
            "kind:inline ONLY. `appfile://` URIs — typically straight from a previous run's " +
            "`files` result — mounted read-only into this run's `files/` directory and " +
            "listed in its prompt. This is how you chain runs: to give a run the output of " +
            "earlier runs, pass their `appfile://` URIs here VERBATIM. Never copy a previous " +
            "run's content into `prompt`: re-typing it costs tokens twice, and every URL, figure " +
            "and date you retype is one you can get wrong — the file itself cannot be. No " +
            "manifest change is needed; the platform declares the input field for you. For " +
            "kind:agent this argument is rejected — a published agent's input schema is a " +
            "versioned contract, so pass the URI through one of its declared file fields instead.",
        },
      },
      required: ["kind"],
    },
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    const signal = extra.signal;
    throwIfAborted(signal);
    if (!ctx.permissions.has("mcp:invoke")) {
      emit(ctx, { tool: "run_and_wait", durationMs: performance.now() - start, outcome: "denied" });
      return textResult({ error: "Permission 'mcp:invoke' is required to launch runs." }, true);
    }
    // Checked HERE, before the launch, because this tool's second half polls
    // `GET /api/runs/{id}` through the same in-process dispatch — and
    // `internal-dispatch.ts` is explicit that the marker "does not
    // authenticate, elevate, or alter identity", so the caller's own scopes
    // gate the poll. Without this, a credential holding `agents:run` but not
    // `runs:read` provisions the container, incurs the LLM spend, and only THEN
    // takes a 403 on the first poll: a billed orphan instead of a refusal. The
    // description above also tells the model not to fall back to `getRun`, so
    // there is no recovery path once the run is away.
    if (!ctx.permissions.has("runs:read")) {
      emit(ctx, { tool: "run_and_wait", durationMs: performance.now() - start, outcome: "denied" });
      return textResult(
        {
          error:
            "Permission 'runs:read' is required to wait for a run. Launching without it would " +
            "start the run and then fail to read its status.",
        },
        true,
      );
    }

    const kind = asString(args.kind);
    if (kind !== "agent" && kind !== "inline") {
      emit(ctx, {
        tool: "run_and_wait",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      throw new McpError(ErrorCode.InvalidParams, "`kind` must be 'agent' or 'inline'.");
    }

    // Trusted in-process dispatch: forward the caller's auth + the self-dispatch
    // marker (same as invoke_operation), and route the launch and poll fetches
    // back through the platform app. `launchRunAndWait` (shared with the chat
    // paths) owns the launch body construction + validation for both kinds.
    const dispatchHeaders = new Headers(ctx.authHeaders);
    dispatchHeaders.set(...internalDispatchHeader());
    const dispatchFetch = ((input, init) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      return ctx.dispatch(request);
    }) as typeof fetch;

    const launched = await launchRunAndWait(args, {
      origin: ctx.origin,
      headers: dispatchHeaders,
      fetch: dispatchFetch,
      signal,
    });
    if (!launched.ok) {
      // A launch HTTP failure (payload carries a numeric `status`) reached the
      // route and it rejected the request (bad input, unconnected integration,
      // no published version, …) — reported as an `invoked` POST. A pre-dispatch
      // validation failure (payload carries an `error`) never touched the route.
      const launchStatus = launched.step.payload.status;
      if (typeof launchStatus === "number") {
        emit(ctx, {
          tool: "run_and_wait",
          durationMs: performance.now() - start,
          method: "POST",
          status: launchStatus,
          outcome: "invoked",
        });
      } else {
        emit(ctx, {
          tool: "run_and_wait",
          durationMs: performance.now() - start,
          outcome: "rejected",
        });
      }
      return textResult(launched.step.payload, true);
    }

    const runId = launched.launch.runId;
    emit(ctx, {
      tool: "run_and_wait",
      durationMs: performance.now() - start,
      operationId: kind === "agent" ? "runAgent" : "runInline",
      status: launched.launchStatus,
      outcome: "invoked",
    });

    const final = await waitForRunAndWaitCompletion(launched.launch, {
      origin: ctx.origin,
      headers: dispatchHeaders,
      fetch: dispatchFetch,
      signal,
    });

    // Report the REAL run outcome, not the polling GET's HTTP status (which is
    // always 200 for a completed run). Map the run's terminal status to an
    // HTTP-shaped code so a failed/timed-out/cancelled run is distinguishable
    // in telemetry.
    const runStatus = (final.payload as { status?: unknown }).status;
    emit(ctx, {
      tool: "run_and_wait",
      durationMs: performance.now() - start,
      operationId: "getRun",
      method: "GET",
      status: typeof runStatus === "number" ? runStatus : runStatusToHttp(runStatus),
      outcome: "invoked",
    });

    // Enrich the terminal result with the run's published files (D6). The
    // SAME enrichment the chat gets from `runAndWaitStepsWithFiles`, reused
    // via `fetchRunFiles` (best-effort, empty on any failure). Beyond echoing
    // them in the text payload, each is returned as an MCP `resource_link`
    // content block (spec 2025-06-18) so an external client (claude.ai, …)
    // consumes them natively — read one with `resources/read`, or chain its
    // `appfile://` URI into a follow-up run's input file field.
    if (!final.isError) {
      const files = await fetchRunFiles(runId, {
        origin: ctx.origin,
        headers: dispatchHeaders,
        fetch: dispatchFetch,
        signal,
      });
      if (files.length > 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ...final.payload, files }, null, 2) },
            ...files.map(fileResourceLink),
          ],
          isError: false,
        };
      }
    }
    return textResult(final.payload, final.isError);
  };

  return { descriptor, handler };
}

// --- list_files --------------------------------------------------------

const DEFAULT_FILE_LIST_LIMIT = 20;
const MAX_FILE_LIST_LIMIT = 100;

/** Dispatch an in-process GET, forwarding the caller's auth + trusted marker. */
function dispatchGet(ctx: McpToolContext, url: URL): Promise<Response> {
  const headers = new Headers(ctx.authHeaders);
  headers.set(...internalDispatchHeader());
  return ctx.dispatch(new Request(url.toString(), { method: "GET", headers }));
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
    // Casing mirrors FileDto (CASING_CONVENTIONS.md 4b): `packageId`/`createdAt`
    // camelCase carve-outs; `run_id` a snake_case domain field.
    run_id: asString(r?.run_id) ?? null,
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
      "`run_id`, `chat_session_id`, or `purpose`. Each row carries an `appfile://` URI you can " +
      "pass verbatim into a run_and_wait input file field (to feed a file to another agent) " +
      "or read with read_file. Returns `{ files: [...], has_more }`.",
    annotations: {
      title: "List files",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "Only files produced by / attached to this run.",
        },
        chat_session_id: {
          type: "string",
          description: "Only files attached to this chat session.",
        },
        purpose: {
          type: "string",
          enum: ["user_upload", "agent_output"],
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
    const runId = asString(args.run_id);
    if (runId) query.run_id = runId;
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
      resultCount: files.length,
    });
    return textResult({ files, has_more: body?.hasMore === true });
  };

  return { descriptor, handler };
}

function buildReadFileTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "read_file",
    description:
      "Read an appfile:// URI through the same file ACL and storage path as resources/read. " +
      "Small text and binary files are returned as embedded MCP resources; oversized or " +
      "non-downloadable files return capability-aware metadata.",
    annotations: {
      title: "Read file",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["uri"],
      properties: {
        uri: { type: "string", description: "An appfile:// URI returned by list_files." },
      },
    },
  };

  const provider = buildFileResourceProvider(ctx);
  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const uri = asString(args.uri);
    if (!uri) throw new McpError(ErrorCode.InvalidParams, "uri is required.");
    const result = await provider.read(uri, extra);
    return {
      content: result.contents.map((resource) => ({ type: "resource", resource })),
      isError: false,
    } as CallToolResult;
  };
  return { descriptor, handler };
}

// --- resources/read for appfile:// ----------------------------------------

/**
 * The `resources/read` provider for `appfile://file_xxx` URIs — lets an MCP
 * client read a file referenced by a `resource_link` (or a known
 * `appfile://` URI) WITHOUT going through the REST API.
 *
 * Authorization + scope resolution call the files SERVICE directly with the
 * MCP session's resolved actor (`getFileForActor`), which enforces the same
 * container ACL the REST route does (a foreign/unknown id is a 404 → surfaced as
 * an MCP error) and derives the caller's {@link FileCapabilities} from the
 * one `getFileCapabilities`. The bytes are read via `streamFileContent`
 * — NOT an in-process `GET /content` — so there is no 307-presigned-redirect the
 * reader cannot follow: the read behaves identically on FS, S3-proxy, and
 * S3-presigned deployments (the bug this replaces).
 *
 * Return shape (each < ~1 MB total):
 *  - textual mime, ≤ {@link RESOURCE_TEXT_MAX_BYTES} → `text` contents.
 *  - non-textual, ≤ {@link RESOURCE_BLOB_MAX_BYTES} → base64 `blob` contents.
 *  - larger (either kind), OR not downloadable by this caller → metadata-only
 *    JSON, including the capabilities and (when downloadable) the REST content
 *    URL hint. When the caller lacks `metadata` (a non-creator upload) the JSON
 *    itself is degraded (generic name + mime, no sha256), flowing from the same
 *    {@link projectFileMetadata} the DTO uses.
 *
 * Deliberately provides NO `list()` (files are not enumerated under
 * `resources/list` per the plan/spec — they surface only via `resource_link`);
 * omitting it makes `resources/list` return empty.
 */
export function buildFileResourceProvider(ctx: McpToolContext): AppstrateResourceProvider {
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
        throw new McpError(ErrorCode.InvalidParams, `Not a file resource URI: ${uri}`);
      }

      const resolved = await getFileForActor(ctx.scope, ctx.actor, docId, ctx.permissions);
      if (!resolved) {
        throw new McpError(ErrorCode.InvalidParams, `File not found: ${uri}`);
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
      if (isTextShapedMime(normalizeMime(row.mime)) && row.size <= RESOURCE_TEXT_MAX_BYTES) {
        const stream = await streamFileContent(row.storageKey);
        if (stream) {
          const text = await new Response(stream).text();
          return { contents: [{ uri: canonicalUri, mimeType: row.mime, text }] };
        }
      } else if (row.size <= RESOURCE_BLOB_MAX_BYTES) {
        const stream = await streamFileContent(row.storageKey);
        if (stream) {
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          const blob = Buffer.from(bytes).toString("base64");
          return { contents: [{ uri: canonicalUri, mimeType: row.mime, blob }] };
        }
      }

      // Oversized (either kind), or the storage object went missing → metadata.
      return metadataOnly(
        row.id,
        canonicalUri,
        row,
        capabilities,
        "Content omitted — it exceeds the inline size limit (1 MiB text / 700 KiB binary). " +
          "Fetch it from the content_url.",
      );
    },
  };
}

function buildGetMeTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "get_me",
    description:
      "Return the caller's working context: identity (name, email), role in this organization, " +
      "and the integrations the caller already has connected and could attach to an agent " +
      "(their own or org-shared). Call this first to ground who you are acting for, what the " +
      "caller's role allows (operations beyond it fail at invoke time), and which integrations " +
      "to prefer when building or configuring an agent.",
    annotations: {
      title: "Get caller context",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  };

  const handler = async (): Promise<CallToolResult> => {
    const start = performance.now();
    const headers = new Headers(ctx.authHeaders);
    // Trusted in-process re-entry — same rationale as invoke_operation: lets the
    // org-pinned MCP token reach a space-scoped route, and lets requireSpaceContext
    // fall back to the org default space when no X-Space-Id is forwarded.
    headers.set(...internalDispatchHeader());
    const request = new Request(new URL("/api/me/context", ctx.origin).toString(), {
      method: "GET",
      headers,
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
    return readResponse(response);
  };

  return { descriptor, handler };
}

/**
 * Build the per-request tool set. Handlers close over the caller's auth
 * context.
 *
 * There are no hidden aliases for the pre-#1177 tool names (`list_documents`,
 * `read_document`, `validate_package_document`, `import_package_document`) or
 * the `document_uri` argument. They were kept callable-but-unlisted because
 * the server advertises `tools: { listChanged: false }`, so a client that
 * listed before an upgrade and calls an old name after it is behaving
 * correctly. The cost of removing them is bounded and transient: such a client
 * gets `-32602 Unknown tool` and re-lists, rather than being forwarded
 * silently. The cost of keeping them was a permanent second dispatch path
 * whose only proof of life was its own test.
 */
export function buildMcpTools(ctx: McpToolContext): AppstrateToolDefinition[] {
  const tools = [
    buildSearchTool(ctx),
    buildDescribeTool(ctx),
    buildInvokeTool(ctx),
    buildRunAndWaitTool(ctx),
    buildListFilesTool(ctx),
    buildReadFileTool(ctx),
    ...buildPackageFileTools(ctx),
  ];
  // get_me dispatches to GET /api/me/context. A consumer that already injects
  // that payload into its own system prompt (the chat module) drops the tool —
  // it would only re-fetch what the model already has. search_operations is
  // kept either way: the operation index is injected too, but its `best_match`
  // schema still saves a describe_operation round-trip, so it is not redundant.
  if (!ctx.contextInjected) tools.push(buildGetMeTool(ctx));
  return tools;
}
