// SPDX-License-Identifier: Apache-2.0

/**
 * The three progressive-disclosure MCP tools.
 *
 * The platform exposes ~250 operations. Surfacing them as 250 individual
 * MCP tools would blow past every client's tool-definition budget (50 tools
 * ≈ 72K tokens), so instead we expose a tiny fixed surface and let the model
 * discover on demand:
 *
 *   - `search_operations`   — keyword/tag search over the catalog
 *   - `describe_operation`  — full input schema for one operation
 *   - `invoke_operation`    — execute one operation
 *
 * `invoke_operation` dispatches **in-process** through the platform's own
 * Hono app (`app.fetch`), re-entering the full auth pipeline + RBAC. The
 * caller's auth context is forwarded verbatim, so an MCP call can never
 * exceed what the same credential could do over REST. `mcp:invoke` gates the
 * tool; the underlying operation still enforces its own permission.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { getCatalog, collectReferencedSchemas, type CatalogOperation } from "./catalog.ts";
import { internalDispatchHeader } from "../../lib/internal-dispatch.ts";

/** Issue an in-process request back through the platform app. */
export type Dispatch = (req: Request) => Promise<Response>;

/** The three tools, named for telemetry/audit. */
export type McpToolName = "search_operations" | "describe_operation" | "invoke_operation";

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
  /** In-process dispatcher (defaults to the platform app at request time). */
  dispatch: Dispatch;
  /**
   * Optional sink for audit + telemetry events. Defaults to a no-op so unit
   * tests and any non-HTTP caller need not provide one.
   */
  observe?: McpObserver;
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
// Headers the caller may NOT set via the `headers` arg: the auth context is
// forwarded from the inbound MCP request and must not be reshaped by the
// model (no swapping credentials, switching org/app, or forging end-user
// impersonation). Everything else (e.g. Credential-Proxy target headers) is
// allowed — still bounded by RBAC on the dispatched route.
const PROTECTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "x-org-id",
  "x-application-id",
  "appstrate-user",
  "appstrate-version",
  // The internal self-dispatch marker is set by THIS layer (see the dispatch
  // request build below) and exempts the request from outbound resource-
  // audience confinement. A client-supplied value would be a forgery attempt —
  // drop it here so only our authoritative, nonce-valued header survives. (Even
  // without this, the value must equal an unguessable per-process secret, so a
  // forgery cannot succeed; this is defence in depth.)
  internalDispatchHeader()[0],
]);
// Cap the buffered response body so a large list endpoint can't dump
// unbounded text into the model context. Truncation is flagged in the result.
const MAX_RESPONSE_CHARS = 100_000;

function textResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function scoreOperation(op: CatalogOperation, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystack =
    `${op.operationId} ${op.summary} ${op.description} ${op.pathTemplate} ${op.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

function buildSearchTool(ctx: McpToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "search_operations",
    description:
      "Search the Appstrate API for operations by keyword and/or tag. Returns matching " +
      "operationIds with their HTTP method, path, and summary. Use this first to discover " +
      "which operation to call, then describe_operation for its input schema.",
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
    const { operations } = getCatalog();
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
        operation_id: { type: "string", description: "The operationId from search_operations." },
      },
      required: ["operation_id"],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const start = performance.now();
    const operationId = asString(args.operation_id);
    if (!operationId) return textResult({ error: "operation_id is required." }, true);

    const { operations, componentSchemas } = getCatalog();
    const op = operations.get(operationId);
    if (!op) return textResult({ error: `Unknown operationId: ${operationId}` }, true);

    emit(ctx, {
      tool: "describe_operation",
      durationMs: performance.now() - start,
      operationId,
    });

    return textResult({
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
    });
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

  const isTextual =
    contentType.includes("json") || contentType.startsWith("text/") || contentType === "";
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

    if (!operationId) {
      emit(ctx, {
        tool: "invoke_operation",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return textResult({ error: "operation_id is required." }, true);
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
      return textResult({ error: `Unknown operationId: ${operationId}` }, true);
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
        if (typeof value === "string") headers.set(name, value);
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

    const body = asRecord(args.body);
    const sendBody = body !== undefined && METHODS_WITH_BODY.has(op.method);
    if (sendBody) headers.set("content-type", "application/json");

    // Mark this as a trusted in-process self-dispatch. The inbound MCP request
    // already cleared the `/api/mcp` resource boundary's audience check; this
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

/** Build the per-request tool set. Handlers close over the caller's auth context. */
export function buildMcpTools(ctx: McpToolContext): AppstrateToolDefinition[] {
  return [buildSearchTool(ctx), buildDescribeTool(ctx), buildInvokeTool(ctx)];
}
