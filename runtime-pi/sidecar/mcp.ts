// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP exposure of the sidecar's capabilities (Phase 1 of #276).
 *
 * The sidecar already exposes its capabilities as bespoke HTTP routes
 * (`/proxy`, `/run-history`, `/llm/*`). Phase 1 adds an additional `/mcp`
 * endpoint that surfaces those same capabilities through the standard
 * Model Context Protocol so an MCP-aware client (the agent in Phase 5,
 * external `mcp-inspector` for debugging today) can discover and invoke
 * them via `tools/list` + `tools/call`.
 *
 * Key invariants preserved by this module:
 *
 * 1. Existing routes (`/proxy`, `/run-history`, `/llm/*`) are untouched —
 *    Phase 1 is explicitly additive. The MCP tools delegate to the same
 *    Hono routes via in-process `app.request()`. Zero credential code
 *    duplication, zero refactor risk.
 *
 * 2. Stateless transport, **per-request**. Each `/mcp` invocation builds
 *    a fresh `Server` + `WebStandardStreamableHTTPServerTransport` pair,
 *    serves the request, then tears them down. This is not a design
 *    choice — the SDK throws "Stateless transport cannot be reused
 *    across requests" the second time a single
 *    `WebStandardStreamableHTTPServerTransport` constructed with
 *    `sessionIdGenerator: undefined` handles a request. The cost is one
 *    `new Server()` + `transport.connect()` per request, both of which
 *    are pure-memory and synchronous in practice; the upside is that
 *    the agent can issue any number of MCP calls per run lifecycle.
 *
 * 3. Binary responses (e.g. provider calls returning a PDF) flow through
 *    `/proxy` unchanged. Phase 3 of #276 will surface them as MCP
 *    `resources` — for now the MCP `provider_call` tool restricts itself
 *    to text/JSON responses and emits an explicit error otherwise. This
 *    keeps the wire payload manageable and the contract sharp.
 *
 * The endpoint is mounted at `/mcp` because the spec recommends a single
 * URL for both client → server (POST) and server → client (GET stream).
 * We currently only handle POST + DELETE — GET (SSE replay) is out of
 * scope until Phase 3 introduces server-initiated notifications.
 */

import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  ErrorCode,
  McpError,
  type AppstrateToolDefinition,
  type ReadResourceResult,
  type Resource,
} from "@appstrate/mcp-transport";
import { MAX_RESPONSE_SIZE, PROVIDER_ID_RE } from "./helpers.ts";
import type { BlobStore } from "./blob-store.ts";

/**
 * JSON Schema `pattern` mirroring `PROVIDER_ID_RE` from `helpers.ts` —
 * the source of truth used by the `/proxy` route to validate
 * `X-Provider`. We strip the leading/trailing slashes and the regex
 * flags so JSON Schema validators (AJV / the MCP SDK / inspectors) see
 * a portable ECMA-compatible string. Anchors are preserved.
 */
const PROVIDER_ID_PATTERN = PROVIDER_ID_RE.source;

/**
 * Hard cap on the JSON-RPC envelope a single `/mcp` request may carry.
 * The SDK's `WebStandardStreamableHTTPServerTransport.handlePostRequest`
 * calls `await req.json()` unconditionally, so without this guard a
 * misbehaving (or malicious) caller from inside the run network could
 * OOM the sidecar with a multi-GB envelope. 256 KB is generous for any
 * legitimate `tools/call` payload — the legacy `/proxy` route already
 * caps non-substitute bodies at the same 256 KB tier.
 */
const MAX_MCP_REQUEST_BODY_SIZE = 256 * 1024;

/**
 * Headers an LLM caller may NOT inject via `provider_call.args.headers`.
 *
 * The MCP descriptor advertises that routing / sidecar-control headers
 * are filtered server-side. Without this filter, an LLM could supply
 * `X-Stream-Response: 1` to opt into the binary streaming path (which
 * the MCP layer is explicitly designed not to expose in Phase 1),
 * `X-Substitute-Body: 1` to inject `{{credential}}` placeholders into
 * an attacker-controlled payload, or `X-Max-Response-Size` to bypass
 * the response truncation budget. The `X-Provider` and `X-Target`
 * routing headers are also stripped so the LLM can't redirect the
 * request post-validation. Header names are matched case-insensitively
 * (HTTP header semantics).
 */
const PROVIDER_CALL_FORBIDDEN_HEADERS = new Set<string>([
  "x-provider",
  "x-target",
  "x-substitute-body",
  "x-stream-response",
  "x-max-response-size",
  "x-truncated",
  "x-truncated-size",
  "x-auth-refreshed",
]);

/**
 * Strip caller-supplied headers that would forge sidecar control state.
 * Returns the sanitised map plus the list of names that were dropped
 * (used to surface the violation to the agent — silent stripping would
 * mask buggy MCP clients).
 */
function sanitiseProviderCallHeaders(raw: Record<string, string> | undefined): {
  headers: Record<string, string>;
  dropped: string[];
} {
  if (!raw) return { headers: {}, dropped: [] };
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    if (PROVIDER_CALL_FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      dropped.push(name);
      continue;
    }
    headers[name] = value;
  }
  return { headers, dropped };
}

/**
 * Inline payload threshold for `provider_call`. Above this size the
 * response is stored in the BlobStore and the tool returns a
 * `resource_link` content block (Phase 3a of #276) — saves the agent
 * from blowing its context window on a 5MB JSON dump. The agent reads
 * via `client.readResource({ uri })` only if it actually needs the
 * bytes.
 *
 * 32KB is generous for typical LLM-targeted text payloads (a verbose
 * Gmail thread or a Notion page rarely exceeds that), and small enough
 * that >100KB JSON dumps from heavy enterprise APIs spill to blob
 * automatically.
 */
const INLINE_RESPONSE_THRESHOLD = 32 * 1024;

/**
 * Build the `provider_call`, `run_history`, and `llm_complete` MCP
 * tool definitions backed by the supplied Hono app. Tool handlers
 * re-enter the app via `app.request()` — same code path as an external
 * HTTP caller, but in-process (no socket, no JSON re-serialisation
 * beyond what the route itself does).
 *
 * Phase 3a: when a `provider_call` upstream response is binary or
 * exceeds {@link INLINE_RESPONSE_THRESHOLD}, the bytes are stored in
 * the supplied {@link BlobStore} and the tool returns a `resource_link`
 * block instead of an inline text body.
 */
function buildSidecarTools(app: Hono, blobStore?: BlobStore): AppstrateToolDefinition[] {
  const providerCall: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description:
        "Make an authenticated request through the sidecar's credential-injecting proxy. " +
        "The sidecar resolves the named provider's credentials and forwards the request to " +
        "the supplied target URL. Use only with provider IDs declared in the agent bundle's " +
        "`dependencies.providers[]`. Binary responses are not yet supported on this path — " +
        "use the legacy `/proxy` endpoint with `X-Stream-Response: 1` for those (Phase 3 will " +
        "add MCP `resources` for binary passthrough).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target"],
        properties: {
          providerId: {
            type: "string",
            description:
              "Provider identifier as declared in `dependencies.providers[].id` (e.g. `@appstrate/gmail` or `gmail`).",
            // Mirror the regex enforced by the /proxy route on X-Provider —
            // catching a malformed provider id at the MCP layer means the
            // failure surface is the agent loop, not a 400 deep in /proxy.
            // The pattern source lives in `./helpers.ts` (PROVIDER_ID_RE)
            // and is shared between this MCP layer and the bespoke /proxy
            // route, so improvements propagate to both.
            pattern: PROVIDER_ID_PATTERN,
          },
          target: {
            type: "string",
            format: "uri",
            description:
              "Absolute target URL. Must match an entry in the provider's `authorizedUris` " +
              "(or be a non-private URL if the provider is `allowAllUris`).",
          },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
            description: "HTTP method. Defaults to GET.",
          },
          headers: {
            type: "object",
            description:
              "Additional headers to forward. Hop-by-hop headers and the routing " +
              "headers (X-Provider, X-Target, …) are filtered server-side.",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "string",
            description:
              "Request body. Use a JSON-encoded string for JSON endpoints. Binary uploads " +
              "are not supported on this path — use the legacy `/proxy` route.",
          },
          substituteBody: {
            type: "boolean",
            description:
              "When true, the sidecar substitutes `{{credential}}` placeholders in the " +
              "request body. Off by default to avoid accidental token leaks into payloads.",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as {
        providerId: string;
        target: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        substituteBody?: boolean;
      };

      const method = args.method ?? "GET";

      // Refuse `body` on GET/HEAD explicitly rather than silently
      // dropping it. A model that supplies a body genuinely expects it
      // to be sent — silent drop produces a confusing upstream behaviour
      // (server returns "missing field X" while the agent thinks it
      // sent X). Surface the contract violation as a clear tool-level
      // error instead. JSON Schema can't express conditional `required`
      // cleanly across all MCP clients, so we enforce it in the handler.
      if (args.body !== undefined && (method === "GET" || method === "HEAD")) {
        return {
          content: [
            {
              type: "text",
              text: `provider_call: 'body' is not allowed with method '${method}'. Use POST/PUT/PATCH/DELETE if you need to send a request body.`,
            },
          ],
          isError: true,
        };
      }

      const { headers: callerHeaders, dropped } = sanitiseProviderCallHeaders(args.headers);
      if (dropped.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `provider_call: caller-supplied headers may not include sidecar-control names: ` +
                `${dropped.join(", ")}. Use the dedicated tool arguments (substituteBody, …) instead.`,
            },
          ],
          isError: true,
        };
      }
      const headers: Record<string, string> = {
        ...callerHeaders,
        "X-Provider": args.providerId,
        "X-Target": args.target,
      };
      if (args.substituteBody) headers["X-Substitute-Body"] = "1";

      const init: RequestInit = { method, headers };
      if (args.body !== undefined) {
        init.body = args.body;
      }

      const res = await app.request("/proxy", init);
      return responseToToolResult(res, {
        ...(blobStore ? { blobStore } : {}),
        source: `provider:${args.providerId}`,
      });
    },
  };

  const runHistory: AppstrateToolDefinition = {
    descriptor: {
      name: "run_history",
      description:
        "Fetch metadata and optionally the carry-over state or final output of the agent's " +
        "most recent past runs (current run excluded). Returns JSON. " +
        "Use for trend analysis, auditing prior executions, or recovering from a failed run.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Number of past runs to return (1..50, default 10).",
          },
          fields: {
            type: "array",
            items: { type: "string", enum: ["state", "result"] },
            uniqueItems: true,
            description: "Optional subset of `{state, result}` to include per run.",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { limit?: number; fields?: string[] };
      const params = new URLSearchParams();
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.fields?.length) params.set("fields", args.fields.join(","));
      const qs = params.size > 0 ? `?${params.toString()}` : "";

      const res = await app.request(`/run-history${qs}`);
      return responseToToolResult(res, { source: "run_history" });
    },
  };

  // Phase 3a — `llm_complete` MCP tool. Wraps the existing `/llm/*`
  // route so the agent can request completions via `tools/call` instead
  // of bespoke HTTP. Per V1 in claudedocs/MCP_MIGRATION_PLAN.md, we
  // model LLM proxy as a *tool* rather than `sampling/createMessage` —
  // sampling is server-initiated (wrong direction) and barely deployed
  // by 2026-04 hosts. Synchronous in v1 (V12); status heartbeat is a
  // future enhancement.
  const llmComplete: AppstrateToolDefinition = {
    descriptor: {
      name: "llm_complete",
      description:
        "Issue a completion request to the platform-configured LLM. The sidecar substitutes " +
        "the placeholder API key, forwards the request, and returns the upstream response body " +
        "as text. Synchronous: the tool returns once the upstream response is fully received. " +
        "For very long completions consider chunking the prompt instead.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "body"],
        properties: {
          path: {
            type: "string",
            description:
              "Upstream path relative to the LLM base URL (e.g. `/v1/messages`, `/v1/chat/completions`). " +
              "Must start with `/` and contain no path traversal sequences.",
            pattern: "^/[A-Za-z0-9._/-]{1,256}$",
          },
          method: {
            type: "string",
            enum: ["POST", "PUT", "PATCH"],
            description: "HTTP method. Defaults to POST.",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Additional headers to forward. Hop-by-hop headers are filtered server-side. " +
              "Authorization headers using the placeholder are auto-substituted.",
          },
          body: {
            type: "string",
            description: "Request body — JSON-encoded string for typical LLM endpoints.",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as {
        path: string;
        method?: string;
        headers?: Record<string, string>;
        body: string;
      };

      // Defence in depth: even though the JSON Schema pattern restricts
      // the path, we re-check here so any bypass route through the SDK
      // (e.g. callers that disable schema validation) still fails safely.
      if (!/^\/[A-Za-z0-9._/-]{1,256}$/.test(args.path) || args.path.includes("..")) {
        return {
          content: [{ type: "text", text: `llm_complete: invalid path '${args.path}'` }],
          isError: true,
        };
      }

      const init: RequestInit = {
        method: args.method ?? "POST",
        headers: { "Content-Type": "application/json", ...(args.headers ?? {}) },
        body: args.body,
      };

      const res = await app.request(`/llm${args.path}`, init);
      return responseToToolResult(res, {
        ...(blobStore ? { blobStore } : {}),
        source: "llm_complete",
        // LLM responses are large but always text — never spill them to
        // a blob unless they breach the absolute MAX_RESPONSE_SIZE
        // truncation guard, which already kicks in upstream.
        inlineThreshold: MAX_RESPONSE_SIZE,
      });
    },
  };

  return [providerCall, runHistory, llmComplete];
}

/**
 * Build the resource provider for the supplied {@link BlobStore}.
 *
 * Two surfaces:
 * - `list()` — returns an empty array. Per spec, ephemeral
 *   `resource_link` blocks emitted from tools are NOT enumerated by
 *   `resources/list`. This matches the MCP guidance for run-scoped
 *   blob caches.
 * - `read(uri)` — validates the URI is in the active run's namespace
 *   and returns the bytes. Cross-run reads are silently rejected
 *   (treated as not-found per defence-in-depth).
 */
function buildBlobResourceProvider(blobStore: BlobStore) {
  return {
    list: (): Resource[] => [],
    read: (uri: string): ReadResourceResult => {
      const record = blobStore.read(uri);
      if (!record) {
        // -32002 maps to InvalidParams in the SDK error code enum and
        // is the closest match for "URI doesn't resolve" per spec.
        throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
      }
      const isText = record.mimeType.startsWith("text/") || record.mimeType.includes("json");
      if (isText) {
        return {
          contents: [
            {
              uri: record.uri,
              mimeType: record.mimeType,
              text: new TextDecoder("utf-8", { fatal: false }).decode(record.bytes),
            },
          ],
        };
      }
      // Binary — base64-encode per MCP spec (resources/read content
      // block accepts either `text` or `blob`).
      const base64 =
        typeof Buffer !== "undefined"
          ? Buffer.from(record.bytes).toString("base64")
          : btoa(String.fromCharCode(...record.bytes));
      return {
        contents: [{ uri: record.uri, mimeType: record.mimeType, blob: base64 }],
      };
    },
  };
}

interface ResponseToToolResultOptions {
  /** Run-scoped blob store; required to spill non-text or oversized responses. */
  blobStore?: BlobStore;
  /** Source label propagated to the BlobStore record (for observability). */
  source?: string;
  /**
   * Inline threshold override. Above this size, even text responses
   * spill to the blob store so the agent context isn't poisoned by
   * very large dumps. Defaults to {@link INLINE_RESPONSE_THRESHOLD}.
   */
  inlineThreshold?: number;
}

/**
 * Convert a Hono in-process Response into an MCP CallToolResult.
 *
 * Non-OK responses become tool-level errors (`isError: true`) — the
 * model still receives them as data and can react. The SDK reserves
 * thrown errors for protocol-level faults; per-tool 4xx/5xx are
 * domain-level signals.
 *
 * Phase 3a behaviour:
 * - Text/JSON/XML under {@link INLINE_RESPONSE_THRESHOLD} → inline `text` block.
 * - Text/JSON/XML over the threshold OR binary content → spilled to
 *   the BlobStore, returned as a `resource_link` block. The agent
 *   reads the bytes via `client.readResource({ uri })` only if needed.
 * - No BlobStore configured → fall back to the Phase 1 behaviour
 *   (binary rejected with a clear tool-level error).
 */
async function responseToToolResult(
  res: Response,
  options: ResponseToToolResultOptions = {},
): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        mimeType?: string;
      }
  >;
  isError?: boolean;
}> {
  const ct = res.headers.get("content-type") ?? "";
  const isText = ct.startsWith("text/") || ct.includes("json") || ct.includes("xml");
  const threshold = options.inlineThreshold ?? INLINE_RESPONSE_THRESHOLD;

  if (!isText) {
    if (!options.blobStore) {
      return {
        content: [
          {
            type: "text",
            text:
              `provider_call: non-text response of type '${ct || "unknown"}' is not supported on ` +
              `this path without a configured blob store. Phase 3a links binary upstream responses ` +
              `as MCP resources — verify the sidecar was started with a runId.`,
          },
        ],
        isError: true,
      };
    }
    // Spill to blob store and return a resource_link.
    const bytes = await readBodyToBuffer(res, MAX_RESPONSE_SIZE);
    if (bytes === "exceeded") {
      return {
        content: [
          {
            type: "text",
            text:
              `provider_call: response exceeds ${MAX_RESPONSE_SIZE} bytes — refused without truncation ` +
              `(truncating an opaque binary blob is unsafe).`,
          },
        ],
        isError: true,
      };
    }
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "application/octet-stream",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `provider_call: blob store rejected upstream response — ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return res.ok ? { content: [link] } : { content: [link], isError: true };
  }

  // Text — bound the read. We stream into a buffer rather than calling
  // res.text() directly so a hypothetical multi-GB response can never
  // be fully materialised before the cap kicks in.
  const text = await readBodyBounded(res, MAX_RESPONSE_SIZE);

  // If the text body breaches the inline threshold AND we have a blob
  // store, spill it. The agent gets a pointer instead of poisoning its
  // context with a multi-megabyte dump.
  if (options.blobStore && text.length > threshold) {
    const bytes = new TextEncoder().encode(text);
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "text/plain",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch {
      // Blob store full — fall back to inline truncation.
      return res.ok
        ? { content: [{ type: "text", text }] }
        : { content: [{ type: "text", text }], isError: true };
    }
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return res.ok ? { content: [link] } : { content: [link], isError: true };
  }

  if (!res.ok) {
    return { content: [{ type: "text", text }], isError: true };
  }
  return { content: [{ type: "text", text }] };
}

/**
 * Read a Response body as raw bytes, refusing the read if `maxBytes`
 * is breached. Returns `"exceeded"` on overflow — for binary spills we
 * never want a partial body that the agent might mistake for the full
 * content.
 */
async function readBodyToBuffer(res: Response, maxBytes: number): Promise<Uint8Array | "exceeded"> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return "exceeded";
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/**
 * Read a Response body as text, truncating to `maxBytes` bytes. We
 * append a single `[truncated]` marker so the agent can tell the read
 * was bounded — silent truncation would let a bad upstream poison the
 * agent's reasoning with a short-but-wrong prefix.
 */
async function readBodyBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
  return truncated ? `${text}\n[truncated: response exceeded ${maxBytes} bytes]` : text;
}

/**
 * Mount the MCP endpoint on the supplied Hono app.
 *
 * Per-request transport (stateless mode requirement): the SDK's
 * `WebStandardStreamableHTTPServerTransport` constructed with
 * `sessionIdGenerator: undefined` records `_hasHandledRequest = true`
 * after its first call and throws on the second — "Stateless transport
 * cannot be reused across requests. Create a new transport per
 * request." Reusing the same transport across `/mcp` calls would cap
 * the agent at one MCP call per sidecar lifetime, which is unusable.
 *
 * The tool definitions are computed once (pure data — they reference
 * `app.request()` lazily, not `app` state). The `Server` and
 * `WebStandardStreamableHTTPServerTransport` are constructed fresh for
 * each request. Construction is pure-memory and `server.connect()` on
 * the web-standard transport is synchronous in practice, so the
 * per-request cost is negligible compared to the upstream HTTP hop the
 * tool then performs.
 */
export interface MountMcpOptions {
  /** Run-scoped blob store for `provider_call` / `llm_complete` resource spillover. */
  blobStore?: BlobStore;
}

export function mountMcp(app: Hono, options: MountMcpOptions = {}): void {
  const tools = buildSidecarTools(app, options.blobStore);
  const resources = options.blobStore ? buildBlobResourceProvider(options.blobStore) : undefined;

  app.all("/mcp", async (c) => {
    // Body-size guard: the SDK transport calls `await req.json()`
    // unconditionally on POST. We pre-read the body (bounded), then
    // hand a fresh Request to the transport. `Content-Length`, when
    // declared, is enforced up-front; otherwise we stream and abort if
    // the cap is exceeded mid-read. Either way the SDK never sees a
    // body larger than MAX_MCP_REQUEST_BODY_SIZE.
    const method = c.req.method.toUpperCase();
    let forwarded: Request = c.req.raw;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const declared = c.req.header("content-length");
      if (declared !== undefined) {
        const declaredLength = Number(declared);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BODY_SIZE) {
          return c.json(
            {
              jsonrpc: "2.0",
              error: {
                code: -32600,
                message: `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes (declared ${declaredLength}).`,
              },
              id: null,
            },
            413,
          );
        }
      }
      const bodyBytes = await readRequestBodyBounded(c.req.raw, MAX_MCP_REQUEST_BODY_SIZE);
      if (bodyBytes === "exceeded") {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32600,
              message: `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes.`,
            },
            id: null,
          },
          413,
        );
      }
      // Reconstruct a Request the SDK can read once. The SDK clones the
      // Request internally on its first read, so a single rebuild here
      // is sufficient.
      forwarded = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: bodyBytes,
      });
    }

    const server = createMcpServer(
      tools,
      { name: "appstrate-sidecar", version: "1" },
      resources ? { resources } : {},
    );
    // Stateless mode: passing `sessionIdGenerator: undefined` explicitly
    // disables session tracking. Combined with per-request construction,
    // there is no state to leak between agent invocations, no map to
    // bound, and no SDK contract to violate.
    //
    // DNS-rebinding defence: the sidecar binds 0.0.0.0:8080 and lives
    // on the per-run Docker bridge network. The trust boundary is the
    // network, but a developer who exposes the port to their host can
    // be reached by any JS in any browser tab via DNS rebinding. The
    // SDK's optional Origin/Host check costs us nothing and pins the
    // expected callers to the agent container alias and localhost.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: ["sidecar", "127.0.0.1", "localhost"],
    });
    try {
      await server.connect(transport);
      // `handleRequest` returns a `Promise<Response>` we hand straight
      // back to Hono. Awaiting before returning ensures the `finally`
      // teardown runs after the response has been fully composed (the
      // SDK populates the response body synchronously into the Response
      // object before resolving the promise).
      return await transport.handleRequest(forwarded);
    } finally {
      await transport.close();
      await server.close();
    }
  });
}

/**
 * Stream-read a Request body into a Uint8Array, refusing the read if
 * the cumulative size crosses `maxBytes`. Returns `"exceeded"` if the
 * cap was hit, the bytes otherwise. We never materialise an
 * over-budget body — the read is cancelled the moment the limit is
 * crossed.
 */
async function readRequestBodyBounded(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array | "exceeded"> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return "exceeded";
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}
