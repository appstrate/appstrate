// SPDX-License-Identifier: Apache-2.0

/**
 * A `{ns}__api_call` tool's call: a batch of HTTP requests, each sent in-process to the credential
 * proxy's route (`/api/credential-proxy/proxy`) with its control headers set from the typed
 * arguments, and the answers projected into one bounded result.
 */

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra } from "@appstrate/mcp-transport";
import { isPlatformRequestHeader } from "@appstrate/connect/platform-request-headers";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { isTextShapedContentType } from "@appstrate/core/mime";
import { logger } from "../../lib/logger.ts";
import { isRelayedResponse } from "../../lib/proxy-status.ts";
import {
  CREDENTIAL_STATUS_HEADER,
  credentialMember,
  parseCredentialStatus,
  type CredentialStatus,
} from "../../lib/credential-status-header.ts";
import { PROXY_CONTROL_HEADERS } from "../../services/credential-proxy/control-headers.ts";
import { isValidSessionId } from "../../services/credential-proxy/session.ts";
import { CREDENTIAL_PROXY_PATH } from "./catalog.ts";
import {
  asRecord,
  dispatchHeaders,
  jsonResult,
  trySetHeader,
  type Refusal,
} from "./tool-results.ts";
import type { Dispatch } from "./tools.ts";

/** Where and as whom a request is dispatched. */
export interface DispatchContext {
  /** Origin the dispatched requests are addressed to. */
  origin: string;
  /** The caller's auth context, forwarded onto every dispatched request. */
  authHeaders: Headers;
  dispatch: Dispatch;
}

/** What an integration tool's call comes back with, unless it refuses its arguments. */
export interface ToolCallOutcome {
  result: CallToolResult;
  /** The entries the result holds, for the call's event. */
  shownCount: number;
}

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
/**
 * What one batch may take, below an MCP client's 60 s request timeout: past it nothing more is
 * sent, and a request still in flight is abandoned.
 */
export const BATCH_DEADLINE_MS = 45_000;
/** Default cap on one text body: the sidecar's inline budget for a tool output (~8 000 tokens). */
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
/**
 * Body bytes one result carries across all its entries, and so the most `max_response_bytes` may
 * ask for one. A result travels twice (text and `structuredContent`) and JSON-escaped: 256 KiB of
 * bodies keeps it under the ~1 MB practical MCP response limit.
 */
export const MAX_RESULT_BYTES = 256 * 1024;
/** Characters kept of one projected response header. */
const MAX_HEADER_VALUE_CHARS = 2048;

/** The verbs the proxy route declares. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

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
        "JSON, with `Content-Type: application/json` unless you set one. Refused with GET.",
    ),
  substitute_body: z
    .boolean()
    .optional()
    .describe(
      "Also substitute `{{field}}` placeholders in the body. Off by default, so a credential " +
        "never lands in a payload by accident.",
    ),
  connection_id: z
    .uuid()
    .optional()
    .describe(
      "Which of the tool's `connections` to use. Required when the tool lists several and its " +
        "integration also has connections of another auth.",
    ),
});

/** The arguments of a `{ns}__api_call` tool: what the handler parses, and its `input_schema`. */
export const apiCallSchema = z.strictObject({
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

/**
 * What one dispatch came back with: the upstream's response, the proxy's own answer, or none
 * before the batch's deadline (`sent`: it was dispatched, and may have run).
 */
type Outcome =
  | { error: Record<string, unknown> }
  | { deadline: { sent: boolean } }
  | {
      status: number;
      headers: Record<string, string>;
      contentType: string;
      bytes: Uint8Array;
      truncated: boolean;
      /** The proxy's verdict on the connection's credential, on a relayed 401 it judged. */
      credential: CredentialStatus | null;
    };

/** Bytes, so `Request` derives no Content-Type from the body: the caller's is the only one. */
function encodeBody(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

/**
 * The dispatch one request becomes, or the refusal of the argument that cannot be sent. The
 * caller's headers go first and may name no header this layer or the proxy owns, so the auth
 * context and the control headers written after them are the only ones the route reads.
 */
function prepareCall(
  ctx: DispatchContext,
  request: ApiCallRequest,
  index: number,
  shared: { integrationId: string; sessionId: string; maxResponseBytes: number },
): PreparedCall | Refusal {
  const at = (argument: string) => `arguments.requests[${index}].${argument}`;
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
    if (request.method === "GET") {
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
    ["X-Integration-Id", shared.integrationId, "tool"],
    ["X-Target", request.target, at("target")],
    ["X-Connection-Id", request.connection_id, at("connection_id")],
    ["X-Session-Id", shared.sessionId, "arguments.session_id"],
    ["X-Substitute-Body", request.substitute_body ? "1" : undefined, at("substitute_body")],
    ["X-Max-Response-Size", String(shared.maxResponseBytes), "arguments.max_response_bytes"],
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
  ctx: DispatchContext,
  call: PreparedCall,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const response = await ctx.dispatch(
    new Request(new URL(CREDENTIAL_PROXY_PATH, ctx.origin).toString(), {
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
    credential: parseCredentialStatus(response.headers.get(CREDENTIAL_STATUS_HEADER)),
  };
}

/**
 * The first `maxBytes` of a UTF-8 body as text; `cut` when bytes were left out here or before
 * (`cutBefore`), in which case a character the cut falls inside is held back.
 */
export function utf8Head(
  bytes: Uint8Array,
  maxBytes: number,
  cutBefore: boolean,
): { text: string; keptBytes: number; cut: boolean } {
  const kept = bytes.subarray(0, Math.max(0, maxBytes));
  const cut = cutBefore || kept.byteLength < bytes.byteLength;
  return { text: new TextDecoder().decode(kept, { stream: cut }), keptBytes: kept.byteLength, cut };
}

/**
 * The entries of a result, in request order. Text bodies draw on one budget
 * ({@link MAX_RESULT_BYTES}) in that order, so a batch is bounded whatever each response's cap.
 */
function projectOutcomes(outcomes: readonly Outcome[]): {
  results: Record<string, unknown>[];
  failed: number;
  budgetSpent: boolean;
  deadlineReached: boolean;
} {
  let budget = MAX_RESULT_BYTES;
  let failed = 0;
  let budgetSpent = false;
  let deadlineReached = false;
  const results = outcomes.map((outcome, index): Record<string, unknown> => {
    if ("error" in outcome) {
      failed += 1;
      return { index, error: outcome.error };
    }
    if ("deadline" in outcome) {
      failed += 1;
      deadlineReached = true;
      return {
        index,
        error: outcome.deadline.sent
          ? {
              code: "no_answer_before_deadline",
              detail: "Sent, but not answered before the batch's deadline: it may have run.",
            }
          : { code: "not_sent", detail: "Not sent: the batch reached its deadline first." },
      };
    }
    if (outcome.status >= 400) failed += 1;
    const entry = {
      index,
      status: outcome.status,
      headers: outcome.headers,
      ...(outcome.credential ? { credential: credentialMember(outcome.credential) } : {}),
    };
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
    const { text, keptBytes, cut: truncated } = utf8Head(bytes, budget, outcome.truncated);
    budget -= keptBytes;
    if (keptBytes < bytes.byteLength) budgetSpent = true;
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
  return { results, failed, budgetSpent, deadlineReached };
}

export const API_CALL_DESCRIPTION =
  "Calls the integration's API with a connection's credential injected by the platform, never " +
  `shown to you: one request or a batch of up to ${MAX_REQUESTS}.`;

/** What `best_match` says of a `{ns}__api_call` beside its `input_schema`. */
export const API_CALL_USAGE =
  "Requests run concurrently, not in order, and each counts against the proxy's rate limit. " +
  "Returns `{ session_id, results }`, one entry per request, in order. An entry with `status` " +
  "is the upstream's own answer, whatever the status (a 401 there is the upstream refusing the " +
  "connection), with `headers` and a text `body`, cut at `max_response_bytes` " +
  "(`truncated: true`); a non-text body is replaced by its size. A 401 entry with `credential` " +
  "`{ status, cause, detail }` is one the platform failed to recover by refreshing the " +
  "credential: `in_use` (the credential stays in use; the 401 may be a permission refusal or " +
  "transient, and `failures`/`max_failures` count toward flagging the connection) or " +
  "`needs_reconnection` (its owner must reconnect it; calls through it are refused until " +
  "then); without it, the upstream refused the request itself. A 3xx whose `Location` is " +
  "outside the connection's `authorized_uris` comes back as is, unfollowed (unless the request " +
  "fills in a credential `{{field}}`): fetch that `Location` yourself right away, since such " +
  "signed URLs expire fast (1 minute for GitHub Actions logs). An entry with `error` " +
  "`{ status, code, detail }` is the platform's refusal and does not stop the other requests: " +
  "`call_permission_required`, `credential_not_found`, `must_choose_connection` (retry with one " +
  "`errors[0].candidate_connections[].id` as `connection_id`), " +
  "`connection_not_in_org_default`, `pinned_connection_unavailable`, `needs_reconnection`, " +
  "`unauthorized_target`, `rate_limited`. A batch has " +
  `${BATCH_DEADLINE_MS / 1000} s: past it, an entry's \`error\` is \`not_sent\` (repeat it) or ` +
  "`no_answer_before_deadline` (sent, and may have run: check before repeating a write). A " +
  "`detail` naming `X-Connection-Id` means " +
  "`connection_id`. The result is an error only when no request got a successful answer. Pass " +
  "its `session_id` to a later call to keep the upstream's cookies.";

export const API_CALL_INPUT_SCHEMA = z.toJSONSchema(apiCallSchema, { target: "draft-7" });

export type ApiCallArguments = z.infer<typeof apiCallSchema>;

/**
 * Sends the requests of a `{ns}__api_call` through the proxy. The proxy chooses among every
 * connection of the integration, so a tool whose integration also has connections of another
 * auth names one of its own on each request.
 */
export async function executeApiCall(
  ctx: DispatchContext,
  tool: {
    name: string;
    integration: string;
    connections: readonly { connection_id: string }[];
    /** A request names one of `connections`: the integration has connections of another auth. */
    connectionRequired: boolean;
  },
  args: ApiCallArguments,
  extra: AppstrateRequestExtra,
  options: {
    /** Applies to each request naming no `connection_id` of its own. */
    defaultConnectionId: string | undefined;
    /** {@link BATCH_DEADLINE_MS}, unless a test shortens it. */
    deadlineMs: number;
  },
): Promise<ToolCallOutcome | Refusal> {
  const { defaultConnectionId, deadlineMs } = options;
  const { requests } = args;
  // The proxy's cookie-jar session: a fresh one unless the caller continues a previous call's.
  const sessionId = args.session_id ?? crypto.randomUUID();
  const maxResponseBytes = args.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const shared = { integrationId: tool.integration, sessionId, maxResponseBytes };
  const connectionIds = tool.connections.map((connection) => connection.connection_id);

  const calls: PreparedCall[] = [];
  for (const [index, request] of requests.entries()) {
    const argument = `arguments.requests[${index}].connection_id`;
    const asked = request.connection_id ?? defaultConnectionId;
    // A connection id is a UUID: named in any case, sent as the listing spells it.
    let connectionId = connectionIds.find((id) => id.toLowerCase() === asked?.toLowerCase());
    if (asked !== undefined && connectionId === undefined) {
      return {
        code: "invalid_argument",
        error: `${argument} names none of ${tool.name}'s connections.`,
        arguments: [argument],
        hint: `Pass one of: ${connectionIds.join(", ")}.`,
      };
    }
    if (connectionId === undefined && tool.connectionRequired) {
      if (connectionIds.length > 1) {
        return {
          code: "missing_argument",
          error: `${argument} is required: ${tool.name} reaches several connections.`,
          arguments: [argument],
          hint: `Pass one of: ${connectionIds.join(", ")}.`,
        };
      }
      connectionId = connectionIds[0];
    }
    const prepared = prepareCall(
      ctx,
      { ...request, ...(connectionId ? { connection_id: connectionId } : {}) },
      index,
      shared,
    );
    if ("code" in prepared) return prepared;
    calls.push(prepared);
  }

  const signal: AbortSignal | undefined = extra.signal;
  const deadline = AbortSignal.timeout(deadlineMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const outcomes = await mapWithConcurrency(calls, CONCURRENCY, async (prepared) => {
    // The caller's abort sends nothing more and fails the call; the deadline only stops sending.
    signal?.throwIfAborted();
    if (deadline.aborted) return { deadline: { sent: false } } satisfies Outcome;
    // One request failing below the proxy's own error handling must not lose the others.
    return dispatchCall(ctx, prepared, bounded).catch((err: unknown): Outcome => {
      if (signal?.aborted) throw err;
      if (deadline.aborted) return { deadline: { sent: true } };
      logger.error("mcp: call_integration_tool dispatch failed", {
        error: err instanceof Error ? err.name : typeof err,
      });
      return {
        error: { status: 500, code: "internal_error", detail: "The proxy did not answer." },
      };
    });
  });
  const { results, failed, budgetSpent, deadlineReached } = projectOutcomes(outcomes);
  const notes = [
    ...(budgetSpent
      ? [
          `The result's ${MAX_RESULT_BYTES}-byte body budget ran out: later bodies are cut. ` +
            "Every request answered was sent: repeat only the reads, in a smaller batch.",
        ]
      : []),
    ...(deadlineReached
      ? [
          `The batch reached its ${deadlineMs / 1000} s deadline: the entries answered are ` +
            "kept, `not_sent` ones were never sent, `no_answer_before_deadline` ones may have run.",
        ]
      : []),
  ];
  const result = jsonResult(
    {
      session_id: sessionId,
      results,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    },
    // An error only when no request got a successful answer.
    failed === results.length,
  );
  return { result, shownCount: results.length };
}
