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

/** Issue an in-process request back through the platform app. */
export type Dispatch = (req: Request) => Promise<Response>;

export interface McpToolContext {
  /** Origin of the inbound `/mcp` request, e.g. `https://instance.example`. */
  origin: string;
  /** Auth-relevant headers forwarded onto dispatched requests. */
  authHeaders: Headers;
  /** Effective permissions of the caller (from the session/token). */
  permissions: ReadonlySet<string>;
  /** In-process dispatcher (defaults to the platform app at request time). */
  dispatch: Dispatch;
}

const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

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

function buildSearchTool(): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "search_operations",
    description:
      "Search the Appstrate API for operations by keyword and/or tag. Returns matching " +
      "operationIds with their HTTP method, path, and summary. Use this first to discover " +
      "which operation to call, then describe_operation for its input schema.",
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

function buildDescribeTool(): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "describe_operation",
    description:
      "Return the full OpenAPI definition for one operation (parameters, request body, " +
      "responses) with all referenced component schemas inlined, so you can construct a " +
      "valid invoke_operation call.",
    inputSchema: {
      type: "object",
      properties: {
        operation_id: { type: "string", description: "The operationId from search_operations." },
      },
      required: ["operation_id"],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const operationId = asString(args.operation_id);
    if (!operationId) return textResult({ error: "operation_id is required." }, true);

    const { operations, componentSchemas } = getCatalog();
    const op = operations.get(operationId);
    if (!op) return textResult({ error: `Unknown operationId: ${operationId}` }, true);

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

function interpolatePath(op: CatalogOperation, pathParams: Record<string, unknown>): string | null {
  let path = op.pathTemplate;
  for (const name of op.pathParams) {
    const value = pathParams[name];
    if (value === undefined || value === null) return null;
    path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  return path;
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
      },
      required: ["operation_id"],
    },
  };

  const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    if (!ctx.permissions.has("mcp:invoke")) {
      return textResult(
        { error: "Permission 'mcp:invoke' is required to invoke operations." },
        true,
      );
    }

    const operationId = asString(args.operation_id);
    if (!operationId) return textResult({ error: "operation_id is required." }, true);

    const { operations } = getCatalog();
    const op = operations.get(operationId);
    if (!op) return textResult({ error: `Unknown operationId: ${operationId}` }, true);

    const pathParams = asRecord(args.path_params) ?? {};
    const path = interpolatePath(op, pathParams);
    if (path === null) {
      return textResult(
        { error: `Missing path_params. Required: ${op.pathParams.join(", ")}` },
        true,
      );
    }

    const url = new URL(path, ctx.origin);
    applyQuery(url, asRecord(args.query) ?? {});

    const headers = new Headers(ctx.authHeaders);
    const body = asRecord(args.body);
    const sendBody = body !== undefined && METHODS_WITH_BODY.has(op.method);
    if (sendBody) headers.set("content-type", "application/json");

    const request = new Request(url.toString(), {
      method: op.method,
      headers,
      body: sendBody ? JSON.stringify(body) : undefined,
    });

    const response = await ctx.dispatch(request);
    const raw = await response.text();
    let parsed: unknown = raw;
    if ((response.headers.get("content-type") ?? "").includes("application/json") && raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    return textResult({ status: response.status, body: parsed }, response.status >= 400);
  };

  return { descriptor, handler };
}

/** Build the per-request tool set. Handlers close over the caller's auth context. */
export function buildMcpTools(ctx: McpToolContext): AppstrateToolDefinition[] {
  return [buildSearchTool(), buildDescribeTool(), buildInvokeTool(ctx)];
}
