// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * MCP exposure of the sidecar's capabilities — the only agent-facing
 * surface after the migration.
 *
 * The sidecar's HTTP endpoints are `/health` and `/configure`; everything
 * the agent talks to (`provider_call`, `run_history`, `recall_memory`) is
 * dispatched here as MCP tools.
 *
 * Key invariants:
 *
 * 1. `provider_call` calls {@link executeProviderCall} directly via
 *    `proxyDeps`. There is no longer a `/proxy` HTTP envelope — the
 *    same credential-isolation invariants (cred fetch, URL allowlist,
 *    server-side header injection, 401-retry, cookie jar, persistent-
 *    auth-failure reporting) are enforced inside the credential-proxy
 *    core (`./credential-proxy.ts`) which is the SOLE place those
 *    invariants live.
 *
 * 2. `run_history` and `recall_memory` use `proxyDeps.fetchFn` to call
 *    the platform directly (no Hono round-trip). Tests inject a mock
 *    `fetchFn` via `AppDeps`.
 *
 * 3. Stateless transport, **per-request**. Each `/mcp` invocation builds
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
 * 4. Binary upstream responses spill to the run-scoped {@link BlobStore}
 *    and are surfaced as MCP `resource_link` blocks (see
 *    `responseToToolResult`). The agent reads bytes via
 *    `client.readResource({ uri })` only when needed.
 *
 * The endpoint is mounted at `/mcp` because the spec recommends a single
 * URL for both client → server (POST) and server → client (GET stream).
 * We currently only handle POST + DELETE — GET (SSE replay) is out of
 * scope until server-initiated notifications ship.
 */

import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createMcpServer,
  ErrorCode,
  McpError,
  type AppstrateToolDefinition,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
} from "@appstrate/mcp-transport";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  ABSOLUTE_MAX_RESPONSE_SIZE,
  MAX_MCP_ENVELOPE_SIZE,
  MAX_REQUEST_BODY_SIZE,
  MAX_RESPONSE_SIZE,
  PROVIDER_ID_RE,
} from "./helpers.ts";
import { TokenBudget } from "./token-budget.ts";
import { DrainingError, LimiterRegistry } from "./limiter.ts";
import { logger } from "./logger.ts";

/**
 * Strict standard base64 decoder (RFC 4648 §4). Refuses URL-safe
 * (`-_`), MIME-folded (whitespace/newlines), and any non-canonical
 * characters. Returns `"invalid"` instead of throwing so the MCP
 * handler can surface a tool-level error rather than crashing the
 * transport.
 */
function decodeStrictBase64(s: string): Uint8Array | "invalid" {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return "invalid";
  try {
    const buf = Buffer.from(s, "base64");
    const u8 = new Uint8Array(buf.byteLength);
    u8.set(buf);
    return u8;
  } catch {
    return "invalid";
  }
}
import type { BlobStore } from "./blob-store.ts";
import { executeProviderCall, type ProviderCallDeps } from "./credential-proxy.ts";
import {
  UPSTREAM_META_KEY,
  buildPreflightUpstreamMeta,
  buildUpstreamMeta,
  type UpstreamMeta,
} from "./upstream-meta.ts";

/**
 * `_meta` payload attached to every `provider_call` pre-flight error
 * (no upstream contact). Surfacing `status: 0` lets the runtime
 * distinguish "no upstream contact" from "upstream returned 5xx" via
 * the status code rather than the absence of `_meta` — the runtime
 * parser now requires `_meta` on every CallToolResult.
 */
const PROVIDER_CALL_PREFLIGHT_META: Record<string, unknown> = {
  [UPSTREAM_META_KEY]: buildPreflightUpstreamMeta(),
};

/**
 * JSON Schema `pattern` mirroring `PROVIDER_ID_RE` from `helpers.ts` —
 * the source of truth shared with `executeProviderCall`. We strip the
 * leading/trailing slashes and the regex flags so JSON Schema
 * validators (AJV / the MCP SDK / inspectors) see a portable
 * ECMA-compatible string. Anchors are preserved.
 */
const PROVIDER_ID_PATTERN = PROVIDER_ID_RE.source;

/**
 * Re-exported alias for the JSON-RPC envelope cap so call sites in this
 * file read consistently. See {@link MAX_MCP_ENVELOPE_SIZE} for the
 * canonical definition (and the `SIDECAR_MAX_MCP_ENVELOPE_BYTES` env
 * override).
 */
const MAX_MCP_REQUEST_BODY_SIZE = MAX_MCP_ENVELOPE_SIZE;

/**
 * Hostnames the agent uses to reach the sidecar. The Docker bridge
 * exposes the sidecar under the `sidecar` alias on port 8080; the
 * process orchestrator (used by `appstrate run` and tests) exposes it
 * under `localhost`/`127.0.0.1` on a *dynamic* port.
 *
 * The MCP SDK's built-in `allowedHosts` does an exact-match check
 * including port, which fails the dynamic-port case (Host header
 * `localhost:51123` is not in the list). We do the validation
 * ourselves — splitting hostname from port — and disable the SDK's
 * own host check via `enableDnsRebindingProtection: false`. The DNS-
 * rebinding defence is preserved because every legitimate caller
 * resolves to one of these hostnames; an attacker rebinding a public
 * domain to 127.0.0.1 still hits a Host header that does not match.
 */
const ALLOWED_HOSTNAMES = new Set(["sidecar", "127.0.0.1", "localhost"]);

function jsonRpcErrorResponse(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validateMcpHostHeader(req: Request): Response | undefined {
  const hostHeader = req.headers.get("host");
  if (!hostHeader) {
    return jsonRpcErrorResponse(403, -32000, "Invalid Host header: <missing>");
  }
  // Strip port: hostname is everything before the last `:` (handles
  // IPv6 literals `[::1]:8080` too — split on `]:` for them, but the
  // sidecar's allowlist contains no IPv6 literals so a simple last-`:`
  // split is sufficient here).
  const colonIdx = hostHeader.lastIndexOf(":");
  const hostname = colonIdx >= 0 ? hostHeader.slice(0, colonIdx) : hostHeader;
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return jsonRpcErrorResponse(403, -32000, `Invalid Host header: ${hostHeader}`);
  }
  return undefined;
}

/**
 * Headers an LLM caller may NOT inject via `provider_call.args.headers`.
 *
 * The MCP descriptor advertises that routing / sidecar-control headers
 * are filtered server-side. Without this filter, an LLM could supply
 * `X-Stream-Response: 1` to opt into the binary streaming path (which
 * the MCP layer deliberately does not expose),
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
 * Legacy byte-based inline threshold. Kept as a defence-in-depth
 * fallback when no {@link TokenBudget} is configured (today: never in
 * production, but the option keeps tests and embedders simple).
 *
 * The token-aware path (see {@link TokenBudget}) is the primary
 * gate: dense JSON / base64 hits the agent's context budget far
 * harder than a byte cap suggests, and small calls accumulate.
 */
const INLINE_RESPONSE_THRESHOLD_BYTES = 32 * 1024;

/**
 * MCP `_meta` key under which the sidecar surfaces token-budget
 * accounting to the agent runtime. Agent-side resolvers can read this
 * to display "X / Y tokens of run budget consumed" or to react to
 * structured truncation events.
 *
 * Distinct from {@link UPSTREAM_META_KEY} (which carries upstream
 * `{ status, headers }`) so a CallToolResult can carry both without
 * collision.
 */
export const TOKEN_BUDGET_META_KEY = "appstrate://token-budget";

/**
 * Discriminated reason surfaced in the agent-facing `_meta` payload.
 * Wider than {@link BudgetDecision.reason} because it adds the
 * caller-driven fallback states (no blob store wired, blob store full)
 * the budget tracker itself cannot produce.
 */
type TokenBudgetMetaReason =
  | "under_inline_cap"
  | "exceeds_inline_cap"
  | "exceeds_run_budget"
  | "blob_store_full"
  | "no_blob_store_configured";

/**
 * Shape of the {@link TOKEN_BUDGET_META_KEY} payload. Stable wire
 * contract — extensions append, never rename.
 */
interface TokenBudgetMeta {
  /** Tokens estimated for *this* tool output. */
  estimatedTokens: number;
  /** Cumulative tool-output tokens consumed in the run so far. */
  consumedTokens: number;
  /** Configured run-level ceiling. */
  runBudgetTokens: number;
  /** Configured per-call inline cap. */
  inlineCapTokens: number;
  /** What the budget tracker decided (after caller overrides). */
  decision: "inline" | "spill";
  /** Why it decided that way (machine-readable). */
  reason: TokenBudgetMetaReason;
}

/**
 * Build the `provider_call`, `run_history`, and `recall_memory` MCP
 * tool definitions. All three tools are implemented in-process —
 * `provider_call` calls {@link executeProviderCall} directly via
 * {@link MountMcpOptions.proxyDeps}; `run_history` and `recall_memory`
 * call `proxyDeps.fetchFn` against the platform upstream. None of
 * these tools round-trip through a Hono HTTP envelope.
 *
 * When a `provider_call` upstream response is binary, exceeds the
 * per-call token cap, or would push the run-level cumulative budget
 * past its ceiling (see {@link TokenBudget}), the bytes are stored in
 * the supplied {@link BlobStore} and the tool returns a `resource_link`
 * block instead of an inline text body. The legacy byte threshold
 * {@link INLINE_RESPONSE_THRESHOLD_BYTES} is consulted only when no
 * {@link TokenBudget} is wired (tests / embedders).
 */
function buildSidecarTools(options: MountMcpOptions): AppstrateToolDefinition[] {
  const { blobStore, proxyDeps, tokenBudget, providerCallLimiter } = options;
  const { config, fetchFn } = proxyDeps;
  const providerCall: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description:
        "Make an authenticated request through the sidecar's credential-injecting proxy. " +
        "The sidecar resolves the named provider's credentials and forwards the request to " +
        "the supplied target URL. Use only with provider IDs declared in the agent bundle's " +
        "`dependencies.providers[]`. Binary upstream responses spill to MCP `resources` and " +
        "are returned as a `resource_link`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["providerId", "target"],
        properties: {
          providerId: {
            type: "string",
            description:
              "Provider identifier as declared in `dependencies.providers[].id` (e.g. `@appstrate/gmail` or `gmail`).",
            // The pattern source is `PROVIDER_ID_RE` in `helpers.ts` —
            // shared with `executeProviderCall` so the same shape gates
            // the MCP descriptor and the credential-proxy core.
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
              "Additional headers to forward. Hop-by-hop headers and sidecar-control " +
              "headers (X-Provider, X-Target, X-Substitute-Body, …) are filtered " +
              "server-side.",
            additionalProperties: { type: "string" },
          },
          body: {
            description:
              "Request body. Use a string for text/JSON endpoints, or " +
              "`{ fromBytes: <base64>, encoding: 'base64' }` for binary uploads. " +
              "Standard base64 (RFC 4648 §4) only — no URL-safe alphabet, no whitespace.",
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                required: ["fromBytes", "encoding"],
                properties: {
                  fromBytes: { type: "string" },
                  encoding: { const: "base64" },
                },
              },
            ],
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
      // Run-scoped fan-out cap. Without this, an agent that issues N
      // parallel `provider_call`s funnels their full payloads into the
      // next LLM turn, blowing past upstream model TPM windows
      // (issue #427). The limiter is per-provider so generous providers
      // (Gmail >>10) can run higher than rate-sensitive ones without
      // every fanned-out call being capped by the slowest lane. When
      // the sidecar is draining (SIGTERM, issue #435), the limiter
      // rejects with `DrainingError` and the handler surfaces a
      // structured tool error so the agent can react.
      // Validate providerId before `limiter.run()` so a misbehaving agent
      // typoing the id (`"gmial"`, `"@foo/bar baz"`, …) doesn't silently
      // spawn a fresh PQueue per typo. Anything that doesn't match the
      // shared `PROVIDER_ID_RE` lands in a single `_invalid` lane —
      // `providerCallInner`'s own validation will still surface the
      // specific tool error to the agent.
      const raw = (rawArgs as { providerId?: unknown })?.providerId;
      const providerId = typeof raw === "string" && PROVIDER_ID_RE.test(raw) ? raw : "_invalid";
      const run = (): Promise<CallToolResult> => providerCallInner(rawArgs);
      if (!providerCallLimiter) return run();
      try {
        return await providerCallLimiter.run(providerId, run);
      } catch (err) {
        if (err instanceof DrainingError) {
          return {
            content: [
              {
                type: "text",
                text: "provider_call: sidecar is draining (SIGTERM received). Retry after the agent restarts.",
              },
            ],
            structuredContent: { error: { code: "DRAINING", scope: "sidecar" } },
            isError: true,
            _meta: PROVIDER_CALL_PREFLIGHT_META,
          };
        }
        throw err;
      }
    },
  };

  /**
   * Inner handler for `provider_call` — extracted so the
   * concurrency-limiting wrapper above can stay shallow and the
   * pre-flight validation / upstream HTTP body can keep its existing
   * control flow without nested closures.
   */
  async function providerCallInner(rawArgs: unknown): Promise<CallToolResult> {
    const args = rawArgs as {
      providerId: string;
      target: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | { fromBytes: string; encoding: "base64" };
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
        _meta: PROVIDER_CALL_PREFLIGHT_META,
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
        _meta: PROVIDER_CALL_PREFLIGHT_META,
      };
    }

    // Resolve the request body to raw bytes. Two shapes supported:
    //  - string: TextEncoder → bytes (text/JSON endpoints)
    //  - { fromBytes, encoding: "base64" }: base64 → bytes (binary
    //    uploads — runtime resolvers materialise workspace files into
    //    this shape before MCP because JSON-RPC has no native byte
    //    type and forwarding bytes as a string corrupts non-UTF-8
    //    payloads).
    let buffered: ArrayBuffer | undefined;
    let bodyText: string | undefined;
    if (typeof args.body === "string") {
      buffered = new TextEncoder().encode(args.body).buffer;
      bodyText = args.body;
    } else if (args.body && typeof args.body === "object" && "fromBytes" in args.body) {
      if (args.substituteBody) {
        return {
          content: [
            {
              type: "text",
              text:
                "provider_call: substituteBody requires a text body — pass body as a string, " +
                "not { fromBytes }.",
            },
          ],
          isError: true,
          _meta: PROVIDER_CALL_PREFLIGHT_META,
        };
      }
      const decoded = decodeStrictBase64(args.body.fromBytes);
      if (decoded === "invalid") {
        return {
          content: [
            {
              type: "text",
              text:
                "provider_call: body.fromBytes is not standard base64 (RFC 4648 §4, " +
                "alphabet `+/`, no whitespace).",
            },
          ],
          isError: true,
          _meta: PROVIDER_CALL_PREFLIGHT_META,
        };
      }
      if (decoded.byteLength > MAX_REQUEST_BODY_SIZE) {
        return {
          content: [
            {
              type: "text",
              text:
                `provider_call: body.fromBytes is ${decoded.byteLength} bytes, ` +
                `which exceeds the per-request limit of ${MAX_REQUEST_BODY_SIZE} bytes. ` +
                `Operators can raise the cap with SIDECAR_MAX_REQUEST_BODY_BYTES (and ` +
                `SIDECAR_MAX_MCP_ENVELOPE_BYTES, since base64 inflation must still fit ` +
                `the JSON-RPC envelope). Files larger than the cap must be split across ` +
                `multiple provider_call invocations.`,
            },
          ],
          structuredContent: {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              scope: "request_body",
              limit: MAX_REQUEST_BODY_SIZE,
              actual: decoded.byteLength,
              envVar: "SIDECAR_MAX_REQUEST_BODY_BYTES",
            },
          },
          isError: true,
          _meta: PROVIDER_CALL_PREFLIGHT_META,
        };
      }
      buffered = decoded.buffer.slice(
        decoded.byteOffset,
        decoded.byteOffset + decoded.byteLength,
      ) as ArrayBuffer;
    }

    const result = await executeProviderCall(
      {
        providerId: args.providerId,
        targetUrl: args.target,
        method,
        callerHeaders,
        body: buffered
          ? {
              kind: "buffered",
              bytes: buffered,
              ...(bodyText !== undefined && args.substituteBody ? { text: bodyText } : {}),
            }
          : { kind: "none" },
        substituteBody: !!args.substituteBody,
        proxyUrl: config.proxyUrl,
      },
      proxyDeps,
    );
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `provider_call: ${result.error}` }],
        isError: true,
        // Pre-flight failure (cred fetch, URL allowlist, etc): no
        // upstream contact, but the runtime parser requires `_meta`
        // on every CallToolResult — surface `status: 0` so the agent
        // can distinguish "no upstream contact" from "upstream
        // returned 5xx" via the status code.
        _meta: PROVIDER_CALL_PREFLIGHT_META,
      };
    }
    return responseToToolResult(result.response, {
      ...(blobStore ? { blobStore } : {}),
      ...(tokenBudget ? { tokenBudget } : {}),
      source: `provider:${args.providerId}`,
      // Attach upstream `{ status, headers }` to the CallToolResult
      // `_meta` payload so the agent-side resolver can surface real
      // HTTP status / response headers (Location, ETag,
      // Upload-Offset, …) to chunked-upload protocols. Always on for
      // `provider_call` — the runtime parser requires it.
      attachUpstreamMeta: true,
    });
  }

  const runHistory: AppstrateToolDefinition = {
    descriptor: {
      name: "run_history",
      description:
        "Fetch metadata and optionally the carry-over checkpoint or final output of the agent's " +
        'most recent past runs (current run excluded). Returns JSON `{ object: "list", data: [...], hasMore }`. ' +
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
            items: { type: "string", enum: ["checkpoint", "result"] },
            uniqueItems: true,
            description: "Optional subset of `{checkpoint, result}` to include per run.",
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

      const url = `${config.platformApiUrl}/internal/run-history${qs}`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${config.runToken}` },
        });
      } catch (err) {
        const code =
          err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
        const suffix = code ? `: ${code}` : "";
        return {
          content: [{ type: "text", text: `run_history: upstream fetch failed${suffix}` }],
          isError: true,
        };
      }
      return responseToToolResult(res, {
        source: "run_history",
        ...(blobStore ? { blobStore } : {}),
        ...(tokenBudget ? { tokenBudget } : {}),
      });
    },
  };

  // `recall_memory` MCP tool — backs the agent's archive memory store.
  // Pinned memories are already in the system prompt; this tool fetches
  // the archive (everything else) on demand so the working context stays
  // small. See ADR-012.
  const recallMemory: AppstrateToolDefinition = {
    descriptor: {
      name: "recall_memory",
      description:
        "Search the agent's archive memories — durable facts and learnings from past runs that " +
        "are NOT visible in the system prompt by default. Pass an optional `q` to filter by " +
        "case-insensitive substring; omit it to retrieve the most recent archive memories. " +
        "Use this when the prompt's `## Memory` section says you have archived memories worth " +
        "checking, when looking for a fact you remember saving, or before answering a question " +
        "that depends on prior-session context. Returns JSON `{ memories: [...] }`.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          q: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description:
              "Case-insensitive substring to match against memory content (text or JSON). " +
              "Omit for an unfiltered most-recent-first slice.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Max memories to return (1..50, default 10).",
          },
        },
      },
    },
    handler: async (rawArgs) => {
      const args = rawArgs as { q?: string; limit?: number };
      const params = new URLSearchParams();
      if (args.q !== undefined && args.q.length > 0) params.set("q", args.q);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : "";

      const url = `${config.platformApiUrl}/internal/memories${qs}`;
      let res: Response;
      try {
        res = await fetchFn(url, {
          headers: { Authorization: `Bearer ${config.runToken}` },
        });
      } catch (err) {
        const code =
          err instanceof Error && "code" in err ? (err as { code: string }).code : undefined;
        const suffix = code ? `: ${code}` : "";
        return {
          content: [{ type: "text", text: `recall_memory: upstream fetch failed${suffix}` }],
          isError: true,
        };
      }
      return responseToToolResult(res, {
        source: "recall_memory",
        ...(blobStore ? { blobStore } : {}),
        ...(tokenBudget ? { tokenBudget } : {}),
      });
    },
  };

  return [providerCall, runHistory, recallMemory];
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
  /**
   * Run-scoped token budget. When provided, the inline-vs-spill
   * decision for text responses is made on **estimated tokens**, not
   * raw bytes — dense JSON or base64 that would otherwise sneak under
   * the 32 KB byte threshold spills correctly, and a cumulative
   * counter tightens the inline path as the agent's run budget runs
   * down. Absent → fall back to the legacy byte threshold.
   */
  tokenBudget?: TokenBudget;
  /** Source label propagated to the BlobStore record (for observability). */
  source?: string;
  /**
   * Legacy byte threshold override (used when no `tokenBudget` is
   * configured). Defaults to {@link INLINE_RESPONSE_THRESHOLD_BYTES}.
   */
  inlineThresholdBytes?: number;
  /**
   * When true, attach upstream `{ status, headers }` to the
   * `CallToolResult._meta` payload under {@link UPSTREAM_META_KEY}.
   * Required for protocols where the agent must read response
   * headers (`Location:` for resumable uploads, `ETag:` for S3
   * multipart, `Upload-Offset:` for tus). Headers are filtered
   * server-side via the allowlist in `./upstream-meta.ts`.
   *
   * Defaults to false on the legacy `provider_call` path so an
   * existing agent connection sees no wire-format change. The new
   * `provider_upload` Pi tool always passes `true`.
   */
  attachUpstreamMeta?: boolean;
}

/**
 * Pure helper: decide whether a text body should spill, and produce
 * the agent-facing `_meta` payload describing the decision.
 *
 * Folded out of {@link responseToToolResult} so the budget logic is
 * unit-testable in isolation and the surrounding async flow stays
 * linear. When a {@link TokenBudget} is wired, calls
 * {@link TokenBudget.tryReserve} so the inline-record is atomic with
 * the decision (no decide/record interleave under concurrent calls).
 *
 * Returns `meta: undefined` when no budget is configured — the agent
 * sees no `_meta` payload and the legacy byte threshold drives the
 * spill decision.
 */
function evaluateBudget(args: {
  text: string;
  tokenBudget: TokenBudget | undefined;
  byteThreshold: number;
}): { shouldSpill: boolean; meta: TokenBudgetMeta | undefined } {
  if (!args.tokenBudget) {
    return { shouldSpill: args.text.length > args.byteThreshold, meta: undefined };
  }
  const estimated = args.tokenBudget.estimate(args.text);
  const decision = args.tokenBudget.tryReserve(estimated);
  return {
    shouldSpill: decision.decision === "spill",
    meta: {
      estimatedTokens: estimated,
      consumedTokens: decision.consumedTokens,
      runBudgetTokens: decision.runBudgetTokens,
      inlineCapTokens: decision.inlineCapTokens,
      decision: decision.decision,
      reason: decision.reason,
    },
  };
}

/**
 * Convert an upstream `Response` into an MCP CallToolResult.
 *
 * Non-OK responses become tool-level errors (`isError: true`) — the
 * model still receives them as data and can react. The SDK reserves
 * thrown errors for protocol-level faults; per-tool 4xx/5xx are
 * domain-level signals.
 *
 * Behaviour:
 * - Text/JSON/XML whose **estimated token count** fits under the
 *   per-call inline cap AND the run-level cumulative budget → inline
 *   `text` block. Token estimation uses the Anthropic-recommended
 *   ~3.5 chars/token heuristic (see `./token-budget.ts`).
 * - Text/JSON/XML that exceeds the per-call cap OR would push the
 *   cumulative budget past its ceiling → spilled to the BlobStore as
 *   a `resource_link`. The agent reads the bytes via
 *   `client.readResource({ uri })` only if needed.
 * - Binary content → always spilled regardless of size (binary in the
 *   agent's context window is never useful).
 * - No BlobStore configured → binary rejected; text falls back to the
 *   legacy byte threshold. Production always supplies a BlobStore +
 *   TokenBudget via `mountMcp`.
 *
 * Every text-path result carries an `appstrate://token-budget` `_meta`
 * payload (when a TokenBudget is configured) so the agent runtime can
 * surface accounting and react to structured truncation events.
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
  _meta?: Record<string, unknown>;
}> {
  // Capture upstream status + allowlisted headers BEFORE consuming the
  // body. The Response object's `headers` view stays valid after read,
  // but resolving the meta up-front keeps the code path linear and
  // documents the dependency: meta is independent of content.
  const upstreamMeta: UpstreamMeta | undefined = options.attachUpstreamMeta
    ? buildUpstreamMeta(res)
    : undefined;

  // Budget meta accumulates per-response: estimated cost + the
  // tracker's decision are folded in by the text path below. Stays
  // undefined for binary spills (no estimate is meaningful) and when
  // no TokenBudget is configured.
  let budgetMeta: TokenBudgetMeta | undefined;

  type Result = {
    content: Array<
      | { type: "text"; text: string }
      | { type: "resource_link"; uri: string; name: string; mimeType?: string }
    >;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  };
  // Helper: attach `_meta` to every return path. We merge upstream-
  // exchange meta and token-budget meta into a single payload — both
  // are independent of agent-side mapping, both can be present
  // simultaneously.
  const withMeta = (r: Result): Result => {
    if (!upstreamMeta && !budgetMeta) return r;
    const meta: Record<string, unknown> = {};
    if (upstreamMeta) meta[UPSTREAM_META_KEY] = upstreamMeta;
    if (budgetMeta) meta[TOKEN_BUDGET_META_KEY] = budgetMeta;
    return { ...r, _meta: meta };
  };

  const ct = res.headers.get("content-type") ?? "";
  const isText = ct.startsWith("text/") || ct.includes("json") || ct.includes("xml");
  const byteThreshold = options.inlineThresholdBytes ?? INLINE_RESPONSE_THRESHOLD_BYTES;

  if (!isText) {
    if (!options.blobStore) {
      return withMeta({
        content: [
          {
            type: "text",
            text:
              `provider_call: non-text response of type '${ct || "unknown"}' is not supported on ` +
              `this path without a configured blob store. Binary upstream responses are linked as ` +
              `MCP resources — verify the sidecar was started with a runId.`,
          },
        ],
        isError: true,
      });
    }
    // Spill to blob store and return a resource_link.
    // When a blob store is available, raise the cap to ABSOLUTE_MAX_RESPONSE_SIZE:
    // the spillover path exists precisely for bodies larger than MAX_RESPONSE_SIZE,
    // so capping the read at MAX_RESPONSE_SIZE refuses real-world binaries
    // (PDFs 1-10 MB, images, ZIPs) that the agent would consume via pdf-toolkit,
    // vision, etc. Symmetrical to the text path below.
    const binaryReadCap = options.blobStore ? ABSOLUTE_MAX_RESPONSE_SIZE : MAX_RESPONSE_SIZE;
    const bytes = await readBodyToBuffer(res, binaryReadCap);
    if (bytes === "exceeded") {
      return withMeta({
        content: [
          {
            type: "text",
            text:
              `provider_call: response exceeds ${binaryReadCap} bytes (${binaryReadCap >= 1024 * 1024 ? `${Math.round(binaryReadCap / 1024 / 1024)} MB` : `${Math.round(binaryReadCap / 1024)} KB`}) — refused without truncation ` +
              `(truncating an opaque binary blob is unsafe).`,
          },
        ],
        isError: true,
      });
    }
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "application/octet-stream",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch (err) {
      return withMeta({
        content: [
          {
            type: "text",
            text: `provider_call: blob store rejected upstream response — ${getErrorMessage(err)}`,
          },
        ],
        isError: true,
      });
    }
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return withMeta(res.ok ? { content: [link] } : { content: [link], isError: true });
  }

  // Text — bound the read. We stream into a buffer rather than calling
  // res.text() directly so a hypothetical multi-GB response can never
  // be fully materialised before the cap kicks in.
  //
  // When a blob store is available, raise the cap to ABSOLUTE_MAX_RESPONSE_SIZE:
  // the spillover path exists precisely to handle bodies larger than
  // MAX_RESPONSE_SIZE, so capping the read at MAX_RESPONSE_SIZE before deciding
  // to spill silently truncated text bodies above 256 KB (they were spilled,
  // but with a `[truncated]` marker poisoning the JSON). Without a blob store
  // there's no recovery path, so the conservative cap stays.
  const readCap = options.blobStore ? ABSOLUTE_MAX_RESPONSE_SIZE : MAX_RESPONSE_SIZE;
  const text = await readBodyBounded(res, readCap);

  // Token-aware spill decision. The token-budget path uses an atomic
  // tryReserve() so cumulative state doesn't drift under concurrent
  // calls (two awaits between decide() and record() would otherwise
  // let two callers both observe a stale `consumed`). Without a
  // TokenBudget we fall back to the legacy byte threshold so older
  // tests + embedders that don't wire a budget keep working.
  const evaluation = evaluateBudget({
    text,
    tokenBudget: options.tokenBudget,
    byteThreshold,
  });
  budgetMeta = evaluation.meta;
  const shouldSpillForBudget = evaluation.shouldSpill;

  // If the text body should spill AND we have a blob store, spill it.
  // The agent gets a pointer instead of poisoning its context with a
  // dense JSON dump that would silently consume its run budget.
  if (options.blobStore && shouldSpillForBudget) {
    const bytes = new TextEncoder().encode(text);
    let record;
    try {
      record = options.blobStore.put(bytes, {
        mimeType: ct || "text/plain",
        ...(options.source !== undefined ? { source: options.source } : {}),
      });
    } catch (err) {
      // Blob store full — surface a distinct reason and record the
      // forced-inline tokens against the budget. tryReserve() did NOT
      // record on the spill path, so we record explicitly here.
      if (budgetMeta) {
        budgetMeta = { ...budgetMeta, decision: "inline", reason: "blob_store_full" };
        options.tokenBudget?.record(budgetMeta.estimatedTokens);
      }
      logger.warn("token-budget: blob store full, forced inline", {
        source: options.source,
        estimatedTokens: budgetMeta?.estimatedTokens,
        consumedTokens: options.tokenBudget?.consumedTokens(),
        error: getErrorMessage(err),
      });
      const fallback: Result = res.ok
        ? { content: [{ type: "text", text }] }
        : { content: [{ type: "text", text }], isError: true };
      return withMeta(fallback);
    }
    logger.info("token-budget: spilled to blob store", {
      source: options.source,
      reason: budgetMeta?.reason,
      estimatedTokens: budgetMeta?.estimatedTokens,
      consumedTokens: budgetMeta?.consumedTokens,
      uri: record.uri,
    });
    const link = {
      type: "resource_link" as const,
      uri: record.uri,
      name: options.source ?? "blob",
      mimeType: record.mimeType,
    };
    return withMeta(res.ok ? { content: [link] } : { content: [link], isError: true });
  }

  // Inline path — when the budget said spill but no blob store is
  // configured, surface the distinct reason and record the
  // forced-inline tokens. tryReserve() did NOT record on the spill
  // path, so we record explicitly here.
  if (shouldSpillForBudget && !options.blobStore && budgetMeta) {
    budgetMeta = { ...budgetMeta, decision: "inline", reason: "no_blob_store_configured" };
    options.tokenBudget?.record(budgetMeta.estimatedTokens);
    logger.warn("token-budget: no blob store configured, forced inline", {
      source: options.source,
      estimatedTokens: budgetMeta.estimatedTokens,
      consumedTokens: options.tokenBudget?.consumedTokens(),
    });
  }

  if (!res.ok) {
    return withMeta({ content: [{ type: "text", text }], isError: true });
  }
  return withMeta({ content: [{ type: "text", text }] });
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
  /** Run-scoped blob store for `provider_call` resource spillover. */
  blobStore?: BlobStore;
  /**
   * Credential-proxy core deps. `provider_call` calls
   * {@link executeProviderCall} directly with structured args; `run_history`
   * and `recall_memory` use `proxyDeps.fetchFn` + `proxyDeps.config` to
   * reach the platform upstream. Required: there is no longer a legacy
   * HTTP-route fallback.
   */
  proxyDeps: ProviderCallDeps;
  /**
   * Run-scoped token budget. When present, every tool output is run
   * through the budget tracker before being delivered to the agent —
   * dense JSON that fits under the byte cap but would exhaust the
   * context window now spills to the blob store, and a structured
   * `appstrate://token-budget` `_meta` payload records the accounting.
   *
   * Optional only so tests and embedders that don't care about the
   * token path can omit it; production wires a `TokenBudget`
   * unconditionally via `createApp` (see `app.ts`).
   */
  tokenBudget?: TokenBudget;
  /**
   * Run-scoped fan-out limiter for `provider_call`. Caps the number of
   * concurrent upstream HTTP hops a single run can issue at once,
   * per `providerId`. Without a cap an agent that fetches N items in
   * parallel (8 Gmail messages, 20 ClickUp tasks, …) can feed the
   * next LLM turn an over-sized JSON dump and blow past the upstream
   * model's TPM window — see issue #427 for the reference incident
   * and #435 for the per-provider extension.
   *
   * The registry also implements the SIGTERM drain path (#435):
   * once `pause()` is called every subsequent `run()` rejects with
   * `DrainingError`, which surfaces to the agent as a structured
   * `DRAINING` tool error so it can react instead of hanging.
   *
   * Optional only so tests / embedders can omit it; production wires
   * a `LimiterRegistry` unconditionally via `createApp` (see `app.ts`).
   */
  providerCallLimiter?: LimiterRegistry;
}

export function mountMcp(app: Hono, options: MountMcpOptions): void {
  const tools = buildSidecarTools(options);
  const resources = options.blobStore ? buildBlobResourceProvider(options.blobStore) : undefined;

  app.all("/mcp", async (c) => {
    // Host header validation (DNS-rebinding defence). Done here, not by
    // the SDK, so we accept dynamic-port Host values like
    // `localhost:51123` (process-orchestrator mode) while still
    // rejecting anything outside `ALLOWED_HOSTNAMES`.
    const hostError = validateMcpHostHeader(c.req.raw);
    if (hostError) return hostError;

    // Body-size guard: the SDK transport calls `await req.json()`
    // unconditionally on POST. We pre-read the body (bounded), then
    // hand a fresh Request to the transport. `Content-Length`, when
    // declared, is enforced up-front; otherwise we stream and abort if
    // the cap is exceeded mid-read. Either way the SDK never sees a
    // body larger than MAX_MCP_REQUEST_BODY_SIZE.
    const method = c.req.method.toUpperCase();
    let forwarded: Request = c.req.raw;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const envelopeOversizeError = (actual: number | null) => ({
        jsonrpc: "2.0" as const,
        error: {
          code: -32600,
          message:
            actual !== null
              ? `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes (declared ${actual}).`
              : `Request body exceeds ${MAX_MCP_REQUEST_BODY_SIZE} bytes.`,
          data: {
            reason: "PAYLOAD_TOO_LARGE",
            scope: "mcp_envelope",
            limit: MAX_MCP_REQUEST_BODY_SIZE,
            ...(actual !== null ? { actual } : {}),
            envVar: "SIDECAR_MAX_MCP_ENVELOPE_BYTES",
            hint:
              "Raise the JSON-RPC envelope cap via SIDECAR_MAX_MCP_ENVELOPE_BYTES " +
              "(remember base64 inflation: ~1.37×). Per-call body size is also bounded " +
              "by SIDECAR_MAX_REQUEST_BODY_BYTES; both caps must be raised together for " +
              "larger uploads.",
          },
        },
        id: null,
      });
      const declared = c.req.header("content-length");
      if (declared !== undefined) {
        const declaredLength = Number(declared);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BODY_SIZE) {
          return c.json(envelopeOversizeError(declaredLength), 413);
        }
      }
      const bodyBytes = await readRequestBodyBounded(c.req.raw, MAX_MCP_REQUEST_BODY_SIZE);
      if (bodyBytes === "exceeded") {
        return c.json(envelopeOversizeError(null), 413);
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
    // DNS-rebinding defence is enforced above by `validateMcpHostHeader`
    // (port-tolerant, supports dynamic-port deployments). The SDK's own
    // host/origin check is therefore disabled.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: false,
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
