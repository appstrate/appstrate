// SPDX-License-Identifier: Apache-2.0

/**
 * `list_connections` and `api_call`: the credential proxy outside a run, as two tools.
 *
 * Both dispatch in-process to the proxy's own routes (`routes/credential-proxy.ts`), one
 * dispatch per upstream call, so the guard, the rate limit and the access rule
 * (`services/credential-proxy/access.ts`) are the REST door's and none is restated here. The
 * proxy route is kept out of the operation catalog (`isExcludedPath`): `api_call` is the one MCP
 * path to it, with typed arguments where the route takes control headers and a bounded result
 * where it relays the upstream body.
 */

import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra, AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { isPlatformRequestHeader } from "@appstrate/connect/platform-request-headers";
import { renderFieldPath } from "@appstrate/core/api-errors";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { isTextShapedContentType } from "@appstrate/core/mime";
import { logger } from "../../lib/logger.ts";
import { isRelayedResponse } from "../../lib/proxy-status.ts";
import { PROXY_CONTROL_HEADERS } from "../../services/credential-proxy/control-headers.ts";
import { isValidSessionId } from "../../services/credential-proxy/session.ts";
import {
  asRecord,
  dispatchHeaders,
  jsonResult,
  refusalResult,
  trySetHeader,
  type Refusal,
} from "./tool-results.ts";
import type { Dispatch, McpObserver } from "./tools.ts";

interface ConnectionToolContext {
  /** Origin the dispatched requests are addressed to. */
  origin: string;
  /** The caller's auth context, forwarded onto every dispatched request. */
  authHeaders: Headers;
  dispatch: Dispatch;
  observe: McpObserver;
  /** The caller is also offered `run_and_wait`, so the descriptions may name it. */
  runs: boolean;
}

const CONNECTIONS_PATH = "/api/credential-proxy/connections";
const PROXY_PATH = "/api/credential-proxy/proxy";

/**
 * Requests per call: what one tool call may hold before it answers. Every response is kept, up to
 * {@link MAX_RESULT_BYTES} each, until the result is assembled (12.5 MiB at most), and at
 * {@link CONCURRENCY} in flight a full batch is 17 rounds: inside an MCP client's 60 s request
 * timeout when the upstream answers within 3 s. The proxy's rate limit is the route's own and is
 * not sized here: each request is counted there, and one it refuses comes back as a
 * `rate_limited` entry.
 */
const MAX_REQUESTS = 50;
/** Requests in flight: the sidecar's own `api_call` fan-out. */
const CONCURRENCY = 3;
/** Default cap on one text body: the sidecar's inline budget for a tool output (~8 000 tokens). */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
/**
 * Body bytes one result carries across all its entries, and so the most `max_response_bytes` may
 * ask for one. A result travels twice (text and `structuredContent`) and JSON-escaped: 256 KiB of
 * bodies keeps it under the ~1 MB practical MCP response limit.
 */
const MAX_RESULT_BYTES = 256 * 1024;
/** Characters kept of one projected response header. */
const MAX_HEADER_VALUE_CHARS = 2048;
/** Issues one argument refusal names. */
const MAX_REPORTED_ISSUES = 10;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const BODILESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * The framing of the dispatched request, which this layer derives from the body it builds: what a
 * request's `headers` may not carry beyond the platform's own request headers
 * (`isPlatformRequestHeader`) and the proxy's controls (`PROXY_CONTROL_HEADERS`).
 */
const DISPATCH_OWNED_HEADERS: ReadonlySet<string> = new Set(["host", "content-length"]);

/**
 * A header a request may not set: the caller's identity and context are forwarded from the MCP
 * request, and each proxy control is a typed argument (the two streaming ones are never sent: a
 * streamed response skips the buffered cap the result is read under).
 */
function isReservedHeader(lower: string): boolean {
  return (
    isPlatformRequestHeader(lower) ||
    PROXY_CONTROL_HEADERS.has(lower) ||
    DISPATCH_OWNED_HEADERS.has(lower)
  );
}

/** The upstream response headers an entry carries. Never `Set-Cookie` or a credential. */
const RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "location",
  "link",
  "retry-after",
] as const;

const requestSchema = z.strictObject({
  integration_package_id: z
    .string()
    .min(1)
    .describe("Integration package id (`@scope/name`), from list_connections."),
  method: z.enum(METHODS),
  target: z
    .string()
    .min(1)
    .describe(
      "Absolute URL matching one of the connection's `authorized_uris`. Where an entry writes " +
        "`{$credential.<field>}`, write `{{<field>}}` at that place (`{{webhook_url}}`, " +
        "`{{site_url}}/wp-json/…`): the proxy substitutes the connection's value, which you " +
        "never see, ask for or type.",
    ),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Extra request headers. The proxy injects the credential: Authorization, Cookie and its " +
        "own control headers are refused.",
    ),
  body: z
    .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
    .optional()
    .describe(
      "A string is sent as is (set its Content-Type yourself); an object or array is sent as " +
        "JSON, with `Content-Type: application/json` unless you set one. Refused with GET and " +
        "HEAD.",
    ),
  substitute_body: z
    .boolean()
    .optional()
    .describe(
      "Also substitute `{{field}}` placeholders in the body. Off by default, so a credential " +
        "never lands in a payload by accident.",
    ),
  connection_id: z
    .string()
    .min(1)
    .optional()
    .describe("Which connection to use, when you hold several of the integration."),
});

/** The arguments of `api_call`: what the handler parses, and the schema the tool declares. */
const apiCallSchema = z.strictObject({
  requests: z
    .array(requestSchema)
    .min(1)
    .max(MAX_REQUESTS)
    .describe(`1 to ${MAX_REQUESTS} requests.`),
  session_id: z
    .string()
    .refine(isValidSessionId, "must be a UUID v4")
    .optional()
    .describe(
      "The `session_id` of a previous result, to keep that call's upstream cookies. Omit to " +
        "start a session.",
    ),
  max_response_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULT_BYTES)
    .optional()
    .describe(
      `Cap on each text body (default ${DEFAULT_MAX_RESPONSE_BYTES}). One result carries at ` +
        `most ${MAX_RESULT_BYTES} bytes of bodies, all entries together.`,
    ),
});

type ApiCallRequest = z.infer<typeof requestSchema>;

/** One request ready to dispatch: every header it will carry already accepted by `Headers`. */
interface PreparedCall {
  method: string;
  headers: Headers;
  body?: Uint8Array<ArrayBuffer>;
}

/** What one dispatch came back with: the upstream's response, or the proxy's own answer. */
type Outcome =
  | { error: Record<string, unknown> }
  | {
      status: number;
      headers: Record<string, string>;
      contentType: string;
      bytes: Uint8Array;
      truncated: boolean;
    };

/** Bytes, so `Request` derives no Content-Type from the body: the caller's is the only one. */
function encodeBody(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function argumentsRefusal(error: z.ZodError): Refusal {
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => renderFieldPath([...issue.path, key]))
      : [],
  );
  if (unknown.length > 0) {
    return {
      code: "unknown_argument",
      error: `Unknown argument(s): ${unknown.join(", ")}.`,
      arguments: unknown,
    };
  }
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES);
  return {
    code: "invalid_argument",
    error: issues.map((issue) => `${renderFieldPath(issue.path)}: ${issue.message}`).join("; "),
    arguments: [...new Set(issues.map((issue) => renderFieldPath(issue.path)))],
  };
}

/**
 * The dispatch one request becomes, or the refusal of the argument that cannot be sent. The
 * caller's headers go first and may name no header this layer or the proxy owns, so the auth
 * context and the control headers written after them are the only ones the route reads.
 */
function prepareCall(
  ctx: ConnectionToolContext,
  request: ApiCallRequest,
  index: number,
  shared: { sessionId: string; maxResponseBytes: number },
): PreparedCall | Refusal {
  const at = (argument: string) => `requests[${index}].${argument}`;
  const invalid = (argument: string, error: string): Refusal => ({
    code: "invalid_argument",
    error,
    arguments: [argument],
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const lower = name.toLowerCase();
    if (isReservedHeader(lower)) {
      return {
        ...invalid(
          at(`headers.${name}`),
          `${name} cannot be set: the platform sets its own request headers, the proxy ` +
            "injects the connection's credential, and its controls are this tool's arguments.",
        ),
        hint: "Drop it; connection_id, session_id and substitute_body say what it meant.",
      };
    }
    if (!trySetHeader(headers, name, value)) {
      return invalid(at(`headers.${name}`), `Invalid header name or value: ${name}`);
    }
  }

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.body !== undefined) {
    if (BODILESS_METHODS.has(request.method)) {
      return invalid(at("body"), `${request.method} carries no body.`);
    }
    if (typeof request.body === "string") {
      body = encodeBody(request.body);
    } else {
      body = encodeBody(JSON.stringify(request.body));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
  }

  dispatchHeaders(ctx.authHeaders, headers);
  const controls: Array<[header: string, value: string | undefined, argument: string]> = [
    ["X-Integration-Id", request.integration_package_id, at("integration_package_id")],
    ["X-Target", request.target, at("target")],
    ["X-Connection-Id", request.connection_id, at("connection_id")],
    ["X-Session-Id", shared.sessionId, "session_id"],
    ["X-Substitute-Body", request.substitute_body ? "1" : undefined, at("substitute_body")],
    ["X-Max-Response-Size", String(shared.maxResponseBytes), "max_response_bytes"],
  ];
  for (const [header, value, argument] of controls) {
    if (value === undefined) continue;
    if (!trySetHeader(headers, header, value)) {
      return invalid(
        argument,
        `${argument} cannot be sent as written: percent-encode any character outside ASCII.`,
      );
    }
  }
  return { method: request.method, headers, ...(body ? { body } : {}) };
}

/** The proxy's own answer (an RFC 9457 problem), less the members that only restate it. */
async function proxyAnswer(response: Response): Promise<Record<string, unknown>> {
  const problem = asRecord(await response.json().catch(() => undefined));
  if (!problem) {
    return { status: response.status, code: "proxy_error", detail: "No problem document." };
  }
  const { type: _type, title: _title, instance: _instance, ...answer } = problem;
  return { ...answer, status: response.status };
}

async function dispatchCall(
  ctx: ConnectionToolContext,
  call: PreparedCall,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const response = await ctx.dispatch(
    new Request(new URL(PROXY_PATH, ctx.origin).toString(), {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal,
    }),
  );
  // RFC 9209: only a response marked `received-status` is the upstream's.
  if (!isRelayedResponse(response.headers)) return { error: await proxyAnswer(response) };
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value.slice(0, MAX_HEADER_VALUE_CHARS);
  }
  return {
    status: response.status,
    headers,
    contentType: response.headers.get("content-type") ?? "",
    // Already cut by the proxy at `X-Max-Response-Size`.
    bytes: new Uint8Array(await response.arrayBuffer()),
    truncated: response.headers.get("x-truncated") === "true",
  };
}

/**
 * The entries of a result, in request order. Text bodies draw on one budget
 * ({@link MAX_RESULT_BYTES}) in that order, so a batch is bounded whatever each response's cap.
 */
function projectOutcomes(outcomes: readonly Outcome[]): {
  results: Record<string, unknown>[];
  failed: number;
  budgetSpent: boolean;
} {
  let budget = MAX_RESULT_BYTES;
  let failed = 0;
  let budgetSpent = false;
  const results = outcomes.map((outcome, index): Record<string, unknown> => {
    if ("error" in outcome) {
      failed += 1;
      return { index, error: outcome.error };
    }
    if (outcome.status >= 400) failed += 1;
    const entry = { index, status: outcome.status, headers: outcome.headers };
    const { bytes } = outcome;
    if (bytes.byteLength === 0) return entry;
    if (!isTextShapedContentType(outcome.contentType)) {
      return {
        ...entry,
        note: "Non-text response body omitted.",
        bytes: bytes.byteLength,
        ...(outcome.truncated ? { truncated: true } : {}),
      };
    }
    const kept = bytes.subarray(0, budget);
    budget -= kept.byteLength;
    if (kept.byteLength < bytes.byteLength) budgetSpent = true;
    const truncated = outcome.truncated || kept.byteLength < bytes.byteLength;
    // A cut may fall inside a character: `stream` holds the partial one back.
    const text = new TextDecoder().decode(kept, { stream: truncated });
    let body: unknown = text;
    if (!truncated && outcome.contentType.toLowerCase().includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ...entry, body, ...(truncated ? { truncated: true } : {}) };
  });
  return { results, failed, budgetSpent };
}

function buildListConnectionsTool(ctx: ConnectionToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "list_connections",
    description:
      "List what api_call reaches in this space outside a run: your OWN connections, each with " +
      "the `integration_package_id` and `connection_id` to pass, the `authorized_uris` a target must " +
      "match (unless `allow_all_uris`; an entry may hold a `{$credential.<field>}` the proxy " +
      "alone resolves, see api_call's `target`), its `scopes_granted`, and what such a call " +
      "would still refuse: `needs_reconnection`, and `run_required` (an enforced organization " +
      "default governs the integration). A connection another member shared is never listed: " +
      "it and a `run_required` integration are reached through " +
      (ctx.runs ? "a run (run_and_wait)." : "an agent run only."),
    annotations: {
      title: "List callable connections",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  };

  const handler = async (): Promise<CallToolResult> => {
    const start = performance.now();
    const response = await ctx.dispatch(
      new Request(new URL(CONNECTIONS_PATH, ctx.origin).toString(), {
        method: "GET",
        headers: dispatchHeaders(ctx.authHeaders),
      }),
    );
    const body = asRecord(await response.json().catch(() => undefined));
    const connections: unknown[] | undefined =
      response.ok && Array.isArray(body?.data) ? body.data : undefined;
    ctx.observe({
      tool: "list_connections",
      durationMs: performance.now() - start,
      method: "GET",
      path: CONNECTIONS_PATH,
      status: response.status,
      outcome: "invoked",
      ...(connections ? { shownCount: connections.length } : {}),
    });
    // The route's refusal, as `invoke_operation` would relay it.
    if (!connections) return jsonResult({ status: response.status, body: body ?? null }, true);
    return jsonResult({ connections });
  };

  return { descriptor, handler };
}

function buildApiCallTool(ctx: ConnectionToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "api_call",
    description:
      "Call third-party APIs with a connection's credential injected by the platform, never " +
      "shown to you: one request or a batch. Outside a run it reaches your OWN connections " +
      "only; call list_connections first for the ids, each connection's `authorized_uris`, and " +
      "the integrations that need a run. Call directly for deterministic or bulk reads and " +
      "writes" +
      (ctx.runs
        ? "; delegate to run_and_wait instead when the task needs judgement, several dependent " +
          "steps, a connection another member shared, or an agent's configured tools. "
        : ". ") +
      "Requests run concurrently, not in order, and each counts against the proxy's rate " +
      "limit. Returns `{ session_id, results }`, one entry per " +
      "request, in order. An entry with `status` is the upstream's own answer, whatever the " +
      "status (a 401 there is the upstream refusing the connection), with `headers` and a text " +
      "`body`, cut at `max_response_bytes` (`truncated: true`); a non-text body is replaced by " +
      "its size. An entry with `error` `{ status, code, detail }` is the platform's refusal and " +
      "does not stop the other requests: `run_required`, `credential_not_found`, " +
      "`must_choose_connection` (retry with one `errors[0].candidate_connections[].id` as " +
      "`connection_id`), `needs_reconnection`, `unauthorized_target`, `rate_limited`. A " +
      "`detail` naming `X-Connection-Id` means `connection_id`.",
    annotations: {
      title: "Call an API through a connection",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: z.toJSONSchema(apiCallSchema, { target: "draft-7" }) as Tool["inputSchema"],
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    // A malformed call is refused whole, before any request is sent.
    const refuse = (refusal: Refusal): CallToolResult => {
      ctx.observe({
        tool: "api_call",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult(refusal);
    };
    if (args.requests === undefined) {
      return refuse({
        code: "missing_argument",
        error: "requests is required.",
        arguments: ["requests"],
      });
    }
    const parsed = apiCallSchema.safeParse(args);
    if (!parsed.success) return refuse(argumentsRefusal(parsed.error));
    const { requests } = parsed.data;
    // The proxy's cookie-jar session: a fresh one unless the caller continues a previous call's.
    const sessionId = parsed.data.session_id ?? crypto.randomUUID();
    const maxResponseBytes = parsed.data.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    const calls: PreparedCall[] = [];
    for (const [index, request] of requests.entries()) {
      const call = prepareCall(ctx, request, index, { sessionId, maxResponseBytes });
      if ("code" in call) return refuse(call);
      calls.push(call);
    }

    const signal: AbortSignal | undefined = extra.signal;
    const outcomes = await mapWithConcurrency(calls, CONCURRENCY, (call) => {
      // An abort sends nothing more and fails the call.
      signal?.throwIfAborted();
      // One request failing below the proxy's own error handling must not lose the others.
      return dispatchCall(ctx, call, signal).catch((err: unknown): Outcome => {
        if (signal?.aborted) throw err;
        logger.error("mcp: api_call dispatch failed", {
          error: err instanceof Error ? err.name : typeof err,
        });
        return {
          error: { status: 500, code: "internal_error", detail: "The proxy did not answer." },
        };
      });
    });
    const { results, failed, budgetSpent } = projectOutcomes(outcomes);
    ctx.observe({
      tool: "api_call",
      durationMs: performance.now() - start,
      shownCount: results.length,
      outcome: "invoked",
    });
    return jsonResult(
      {
        session_id: sessionId,
        results,
        ...(budgetSpent
          ? {
              note:
                `The result's ${MAX_RESULT_BYTES}-byte body budget ran out: later bodies are ` +
                "cut. Every request was sent: repeat only the reads, in a smaller batch.",
            }
          : {}),
      },
      // An error only when no request got a successful answer.
      failed === results.length,
    );
  };

  return { descriptor, handler };
}

/** Declared together, to a caller `McpSurface.proxies` holds for. */
export function buildConnectionTools(ctx: ConnectionToolContext): AppstrateToolDefinition[] {
  return [buildListConnectionsTool(ctx), buildApiCallTool(ctx)];
}
