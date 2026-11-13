// SPDX-License-Identifier: Apache-2.0

/**
 * `search_integration_tools` and `call_integration_tool`: the tools of the integrations the caller
 * holds a connection of, outside a run, behind two discovery tools.
 *
 * An integration's tool is named as in a run (`{ns}__api_call`, `{ns}__api_call__{auth}` when
 * several of its auths expose one, `{ns}__{tool}` for a typed tool of a remote MCP server). Both
 * tools read the caller's connections from the proxy's listing route and dispatch every upstream
 * request in-process to the proxy routes (`routes/credential-proxy.ts`: `/proxy` for an
 * `api_call`, `/tools/list` and `/tools/call` for a remote server's tools), so the guard, the
 * rate limit and the access rule (`services/credential-proxy/access.ts`) are the REST door's and
 * none is restated here. Those routes are kept out of the operation catalog (`isExcludedPath`):
 * the two tools are the one MCP path to them, with typed arguments where `/proxy` takes control
 * headers and a bounded result where it relays the upstream body.
 */

import { z } from "zod";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppstrateRequestExtra, AppstrateToolDefinition } from "@appstrate/mcp-transport";
import { isPlatformRequestHeader } from "@appstrate/connect/platform-request-headers";
import { renderFieldPath } from "@appstrate/core/api-errors";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { RUN_CONNECT_OFFERS_HEADER } from "@appstrate/core/run-and-wait-client";
import { isTextShapedContentType } from "@appstrate/core/mime";
import {
  getApiCallConfigs,
  missingScopesForConnection,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import {
  allocateMcpToolName,
  allocateMcpToolNamespace,
  normaliseMcpToolNamespace,
} from "@appstrate/core/naming";
import { logger } from "../../lib/logger.ts";
import { isRelayedResponse } from "../../lib/proxy-status.ts";
import {
  CREDENTIAL_STATUS_HEADER,
  parseCredentialStatus,
  type CredentialStatus,
} from "../../lib/credential-status-header.ts";
import { CREDENTIAL_FAILURE_SENTENCES } from "../../lib/credential-failure.ts";
import { PROXY_CONTROL_HEADERS } from "../../services/credential-proxy/control-headers.ts";
import { isValidSessionId } from "../../services/credential-proxy/session.ts";
import {
  CREDENTIAL_PROXY_PATH,
  REMOTE_TOOLS_CALL_PATH,
  REMOTE_TOOLS_LIST_PATH,
} from "./catalog.ts";
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
  /** The manifest a call outside a run is authorized against, `null` when none loads. */
  readManifest: (packageId: string) => Promise<IntegrationManifest | null>;
}

const CONNECTIONS_PATH = "/api/credential-proxy/connections";

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
    .string()
    .min(1)
    .optional()
    .describe(
      "Which of the tool's `connections` to use. Required when the tool lists several and its " +
        "integration also has connections of another auth.",
    ),
});

/** The arguments of a `{ns}__api_call` tool: what the handler parses, and its `input_schema`. */
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
      /** The proxy's verdict on the connection's credential, on a relayed 401 it judged. */
      credential: CredentialStatus | null;
    };

interface CredentialMember {
  status: CredentialStatus["status"];
  cause: CredentialStatus["cause"];
  detail: string;
  failures?: number;
  max_failures?: number;
}

/**
 * The `credential` member of an entry: what the platform concluded about the connection's
 * credential when the upstream refused it and a forced refresh could not recover it. Without it,
 * a 401 is the upstream refusing the request with a credential the platform did not judge.
 */
function credentialMember(credential: CredentialStatus): CredentialMember {
  const member = {
    status: credential.status,
    cause: credential.cause,
    detail: CREDENTIAL_FAILURE_SENTENCES[credential.cause],
  };
  return credential.status === "in_use" &&
    credential.failures !== undefined &&
    credential.maxFailures !== undefined
    ? { ...member, failures: credential.failures, max_failures: credential.maxFailures }
    : member;
}

/** Bytes, so `Request` derives no Content-Type from the body: the caller's is the only one. */
function encodeBody(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

/** The refusal of a parse; `prefix` places the parsed object among the tool's arguments. */
function argumentsRefusal(error: z.ZodError, prefix: PropertyKey[] = []): Refusal {
  const path = (issuePath: PropertyKey[]) => renderFieldPath([...prefix, ...issuePath]);
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => path([...issue.path, key])) : [],
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
    error: issues.map((issue) => `${path(issue.path)}: ${issue.message}`).join("; "),
    arguments: [...new Set(issues.map((issue) => path(issue.path)))],
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
  ctx: ConnectionToolContext,
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

/** One of the caller's connections, as the listing route returns it, less its integration. */
type ListedConnection = Record<string, unknown> & { connection_id: string; auth_key: string };

/** An integration the caller holds a connection of, under the namespace its tools are named in. */
interface ListedIntegration {
  /** The integration package id (`@scope/name`). */
  id: string;
  namespace: string;
  connections: ListedConnection[];
}

/**
 * `connections`, each with the scopes `tool`'s `tools_policy` entry requires on its auth that it
 * lacks (`missing_scopes`): the rule the proxy's selection applies to a typed tool's call
 * (`proxyRequirement`), which answers `insufficient_scopes` with such a connection.
 */
function withMissingScopes(
  manifest: IntegrationManifest,
  tool: string,
  connections: readonly ListedConnection[],
): ListedConnection[] {
  return connections.map((connection) => {
    const granted = Array.isArray(connection.scopes_granted)
      ? connection.scopes_granted.filter((scope): scope is string => typeof scope === "string")
      : [];
    const missing = missingScopesForConnection({
      manifest,
      authKey: connection.auth_key,
      granted,
      agentTools: [tool],
      agentScopes: [],
    });
    return { ...connection, missing_scopes: missing };
  });
}

/** What an integration tool's call comes back with, unless it refuses its arguments. */
interface ToolCallOutcome {
  result: CallToolResult;
  /** The entries the result holds, for the call's event. */
  shownCount: number;
}

/** One tool of an integration the caller holds a connection of. */
interface IntegrationTool {
  /** `{ns}__{tool}`, the name `call_integration_tool` takes. */
  name: string;
  /** The integration package id (`@scope/name`). */
  integration: string;
  /** What the tool does, as a search lists it. */
  description: string;
  /** A remote tool whose server could not be listed: named only, without description or schema. */
  catalogUnreadable?: true;
  /** How to call it and read its result, carried with its `input_schema` by `best_match`. */
  usage: string;
  /** Its arguments: `call_integration_tool` validates `arguments` against it before `execute`. */
  schema: z.ZodType;
  /** `schema` as JSON Schema: the `input_schema` of `best_match`. */
  inputSchema: Record<string, unknown>;
  /** The connections it reaches. */
  connections: ListedConnection[];
  /** Runs a call whose arguments `schema` accepted, with the connection the caller named. */
  execute(
    args: unknown,
    extra: AppstrateRequestExtra,
    connectionId: string | undefined,
  ): Promise<ToolCallOutcome | Refusal>;
}

/** An integration's tools, and the proxy's refusal of its remote server's listing, if any. */
interface IntegrationToolSet {
  tools: IntegrationTool[];
  refusal?: Record<string, unknown>;
}

const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

const API_CALL_DESCRIPTION =
  "Calls the integration's API with a connection's credential injected by the platform, never " +
  `shown to you: one request or a batch of up to ${MAX_REQUESTS}.`;

/** What `best_match` says of a `{ns}__api_call` beside its `input_schema`. */
const API_CALL_USAGE =
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
  "`unauthorized_target`, `rate_limited`. A `detail` naming `X-Connection-Id` means " +
  "`connection_id`. The result is an error only when no request got a successful answer. Pass " +
  "its `session_id` to a later call to keep the upstream's cookies.";

function apiCallDescription(manifest: IntegrationManifest, authKey: string, multiAuth: boolean) {
  const about = typeof manifest.description === "string" ? ` ${manifest.description}` : "";
  const auth = multiAuth ? ` Uses its \`${authKey}\` auth.` : "";
  return `${manifest.display_name ?? manifest.name}.${about}${auth} ${API_CALL_DESCRIPTION}`;
}

const API_CALL_INPUT_SCHEMA = z.toJSONSchema(apiCallSchema, { target: "draft-7" });

type ApiCallArguments = z.infer<typeof apiCallSchema>;

/**
 * Sends the requests of a `{ns}__api_call` through the proxy. The proxy chooses among every
 * connection of the integration, so a tool whose integration also has connections of another
 * auth names one of its own on each request.
 */
async function executeApiCall(
  ctx: ConnectionToolContext,
  tool: { name: string; integration: string; connections: ListedConnection[] },
  sharesIntegration: boolean,
  args: ApiCallArguments,
  extra: AppstrateRequestExtra,
  defaultConnectionId: string | undefined,
): Promise<ToolCallOutcome | Refusal> {
  const { requests } = args;
  // The proxy's cookie-jar session: a fresh one unless the caller continues a previous call's.
  const sessionId = args.session_id ?? crypto.randomUUID();
  const maxResponseBytes = args.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const shared = { integrationId: tool.integration, sessionId, maxResponseBytes };
  const connectionIds = tool.connections.map((connection) => connection.connection_id);

  const calls: PreparedCall[] = [];
  for (const [index, request] of requests.entries()) {
    const argument = `arguments.requests[${index}].connection_id`;
    let connectionId = request.connection_id ?? defaultConnectionId;
    if (connectionId !== undefined && !connectionIds.includes(connectionId)) {
      return {
        code: "invalid_argument",
        error: `${argument} names none of ${tool.name}'s connections.`,
        arguments: [argument],
        hint: `Pass one of: ${connectionIds.join(", ")}.`,
      };
    }
    if (connectionId === undefined && sharesIntegration) {
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
  const outcomes = await mapWithConcurrency(calls, CONCURRENCY, (prepared) => {
    // An abort sends nothing more and fails the call.
    signal?.throwIfAborted();
    // One request failing below the proxy's own error handling must not lose the others.
    return dispatchCall(ctx, prepared, signal).catch((err: unknown): Outcome => {
      if (signal?.aborted) throw err;
      logger.error("mcp: call_integration_tool dispatch failed", {
        error: err instanceof Error ? err.name : typeof err,
      });
      return {
        error: { status: 500, code: "internal_error", detail: "The proxy did not answer." },
      };
    });
  });
  const { results, failed, budgetSpent } = projectOutcomes(outcomes);
  const result = jsonResult(
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
  return { result, shownCount: results.length };
}

/**
 * The integrations the caller holds a connection of, sorted by package id, each under its
 * namespace. Namespaces are allocated over every listed integration in that order, whatever its
 * manifest, so a search and a call name a tool alike while a call reads one manifest only. The
 * listing route's refusal comes back as is.
 */
async function listIntegrations(
  ctx: ConnectionToolContext,
): Promise<{ integrations: ListedIntegration[] } | { refused: { status: number; body: unknown } }> {
  const response = await ctx.dispatch(
    new Request(new URL(CONNECTIONS_PATH, ctx.origin).toString(), {
      method: "GET",
      headers: dispatchHeaders(ctx.authHeaders),
    }),
  );
  const body = asRecord(await response.json().catch(() => undefined));
  if (!response.ok || !Array.isArray(body?.data)) {
    return { refused: { status: response.status, body: body ?? null } };
  }
  const byIntegration = new Map<string, ListedConnection[]>();
  for (const row of body.data as Array<Record<string, unknown>>) {
    const { integration_package_id: integration, ...connection } = row;
    if (typeof integration !== "string") continue;
    const rows = byIntegration.get(integration) ?? [];
    rows.push(connection as ListedConnection);
    byIntegration.set(integration, rows);
  }
  const usedNamespaces = new Set<string>();
  const integrations = [...byIntegration.keys()].sort().map((id) => {
    const namespace = allocateMcpToolNamespace(normaliseMcpToolNamespace(id), usedNamespaces);
    usedNamespaces.add(namespace);
    return { id, namespace, connections: byIntegration.get(id)! };
  });
  return { integrations };
}

/**
 * The tools of one integration: the `api_call` tools its catalog exposes (selection `"*"`, less
 * `hidden_tools` and connect tools) whose auth has a connection, then, for a remote MCP source,
 * the typed tools its server offers, listed with `connectionId` when the caller names one.
 */
async function integrationTools(
  ctx: ConnectionToolContext,
  integration: ListedIntegration,
  manifest: IntegrationManifest,
  connectionId?: string,
): Promise<IntegrationToolSet> {
  const catalog = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((entry) => entry.name),
  );
  const configs = getApiCallConfigs(manifest);
  const apiCallTools = configs
    .filter((config) => catalog.has(config.toolName))
    .map((config) => ({
      config,
      connections: withMissingScopes(
        manifest,
        config.toolName,
        integration.connections.filter((c) => c.auth_key === config.authKey),
      ),
    }))
    .filter((entry) => entry.connections.length > 0)
    .map(({ config, connections }): IntegrationTool => {
      const tool = {
        name: `${integration.namespace}__${config.toolName}`,
        integration: integration.id,
        connections,
      };
      const sharesIntegration = connections.length < integration.connections.length;
      return {
        ...tool,
        description: apiCallDescription(manifest, config.authKey, configs.length > 1),
        usage: API_CALL_USAGE,
        schema: apiCallSchema,
        inputSchema: API_CALL_INPUT_SCHEMA,
        execute: (
          args: ApiCallArguments,
          extra: AppstrateRequestExtra,
          named: string | undefined,
        ) => executeApiCall(ctx, tool, sharesIntegration, args, extra, named),
      };
    });
  if (manifest.source?.kind !== "remote") return { tools: apiCallTools };
  const taken = new Set(apiCallTools.map((tool) => tool.name));
  const remote = await remoteTools(ctx, integration, manifest, taken, connectionId);
  return { ...remote, tools: [...apiCallTools, ...remote.tools] };
}

const REMOTE_TOOL_USAGE =
  "Pass the tool's own arguments in `arguments`, following its `input_schema`. The " +
  "`connection_id` of call_integration_tool names the connection; without it the proxy " +
  "chooses as for an `api_call`. The result is the MCP server's own tool result, relayed " +
  `as is up to ${MAX_RESULT_BYTES} bytes; \`isError: true\` is the tool's own failure.`;

/**
 * A request to the proxy's tool routes. It asks for connect links: the MCP client hands a
 * refusal's `connect_url` to the human driving it, as `run_and_wait` does (see
 * `RUN_CONNECT_OFFERS_HEADER`).
 */
function remoteToolsRequestHeaders(): Headers {
  return new Headers({ "Content-Type": "application/json", [RUN_CONNECT_OFFERS_HEADER]: "1" });
}

/** Upstream arguments: the server validates them against its own schema. */
const remoteArgumentsSchema = z.record(z.string(), z.unknown());

/**
 * The typed tools a remote integration's server offers, read through the proxy's tool listing
 * with the connection the proxy selects for the caller (or the one named), each named
 * `{ns}__{tool}` as in a run. When several connections qualify and none is named, the listing
 * uses the first of the caller's connections the proxy accepts by name. A listing the proxy
 * refuses leaves the integration's `api_call` tools alone, and its refusal is returned.
 */
async function remoteTools(
  ctx: ConnectionToolContext,
  integration: ListedIntegration,
  manifest: IntegrationManifest,
  taken: Set<string>,
  connectionId: string | undefined,
): Promise<IntegrationToolSet> {
  const list = async (named: string | undefined) => {
    const response = await ctx.dispatch(
      new Request(new URL(REMOTE_TOOLS_LIST_PATH, ctx.origin).toString(), {
        method: "POST",
        headers: dispatchHeaders(ctx.authHeaders, remoteToolsRequestHeaders()),
        body: JSON.stringify({
          integration_id: integration.id,
          ...(named ? { connection_id: named } : {}),
        }),
      }),
    );
    return { ok: response.ok, body: asRecord(await response.json().catch(() => undefined)) };
  };
  let listing = await list(connectionId);
  if (
    !listing.ok &&
    connectionId === undefined &&
    listing.body?.code === "must_choose_connection"
  ) {
    for (const connection of integration.connections) {
      const named = await list(connection.connection_id);
      if (named.ok) {
        listing = named;
        break;
      }
    }
  }
  const { body } = listing;
  if (!listing.ok || !Array.isArray(body?.tools)) {
    return { tools: [], refusal: body ?? { error: "The tool listing did not answer." } };
  }
  const listed = body.listed !== false;
  const about = manifest.display_name ?? manifest.name;
  const tools = (body.tools as RemoteToolListing[]).flatMap((upstream): IntegrationTool[] => {
    let name: string;
    try {
      name = allocateMcpToolName(integration.namespace, upstream.name, (n) => taken.has(n));
    } catch {
      return [];
    }
    taken.add(name);
    return [
      {
        name,
        integration: integration.id,
        description: upstream.description ? `${about}. ${upstream.description}` : `${about}.`,
        ...(listed ? {} : { catalogUnreadable: true }),
        usage: REMOTE_TOOL_USAGE,
        schema: remoteArgumentsSchema,
        inputSchema: upstream.input_schema,
        connections: withMissingScopes(manifest, upstream.name, integration.connections),
        execute: (
          args: Record<string, unknown>,
          extra: AppstrateRequestExtra,
          named: string | undefined,
        ) => executeRemoteTool(ctx, integration.id, upstream.name, args, extra, named),
      },
    ];
  });
  return { tools };
}

/** A tool as `/api/credential-proxy/tools/list` returns it. */
interface RemoteToolListing {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** One `tools/call` through the proxy's tool route; its refusal comes back as is. */
async function executeRemoteTool(
  ctx: ConnectionToolContext,
  integrationId: string,
  name: string,
  args: Record<string, unknown>,
  extra: AppstrateRequestExtra,
  connectionId: string | undefined,
): Promise<ToolCallOutcome> {
  const response = await ctx.dispatch(
    new Request(new URL(REMOTE_TOOLS_CALL_PATH, ctx.origin).toString(), {
      method: "POST",
      headers: dispatchHeaders(ctx.authHeaders, remoteToolsRequestHeaders()),
      body: JSON.stringify({
        integration_id: integrationId,
        ...(connectionId ? { connection_id: connectionId } : {}),
        name,
        arguments: args,
      }),
      ...(extra.signal ? { signal: extra.signal } : {}),
    }),
  );
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const body = asRecord(parsed);
  const result = asRecord(body?.result);
  if (!response.ok || !result) {
    return { result: jsonResult(body ?? { status: response.status }, true), shownCount: 0 };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESULT_BYTES) {
    return {
      result: jsonResult(
        {
          error: `The tool's result exceeds ${MAX_RESULT_BYTES} bytes and is not relayed.`,
          hint: "Ask the tool for less, with narrower arguments.",
        },
        true,
      ),
      shownCount: 0,
    };
  }
  return { result: result as CallToolResult, shownCount: 1 };
}

function scoreTool(tool: IntegrationTool, tokens: readonly string[]): number {
  const haystack = `${tool.name} ${tool.integration} ${tool.description}`.toLowerCase();
  let score = 0;
  for (const token of tokens) if (haystack.includes(token)) score += 1;
  return score;
}

/** A tool as a search lists it. */
function listedTool(tool: IntegrationTool): Record<string, unknown> {
  return {
    tool: tool.name,
    integration: tool.integration,
    description: tool.description,
    ...(tool.catalogUnreadable ? { catalog_unreadable: true } : {}),
    connections: tool.connections,
  };
}

function buildSearchIntegrationToolsTool(ctx: ConnectionToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "search_integration_tools",
    description:
      "Search the tools of the integrations you hold a connection of in this space, by keyword " +
      "and/or integration; with neither, list every tool you can call: each integration's " +
      "`api_call` tools and, for an integration backed by a remote MCP server, the typed tools " +
      "that server offers. Each result has the `tool` name to pass to call_integration_tool, " +
      "its `integration`, a `description`, and the `connections` it reaches; " +
      "`catalog_unreadable: true` marks a typed tool whose server could not be listed, named " +
      "without description or schema. With `credential-proxy:call`: your own connections and " +
      "those other members shared into the space (`owned_by_actor: false`); with " +
      "`credential-proxy:call-own` alone, your own only. Each connection has the " +
      "`connection_id` to pass, the `authorized_uris` a target must match (unless " +
      "`allow_all_uris`; an entry may hold a `{$credential.<field>}` the proxy alone resolves, " +
      "see the `target` argument of `input_schema`), its `scopes_granted`, and what a call " +
      "would still refuse: `missing_scopes` (the scopes the tool's policy requires on the " +
      "connection's auth that it lacks; a typed tool's call with it answers " +
      "`insufficient_scopes`), `needs_reconnection`, and " +
      "`call_permission_required` (an enforced " +
      "organization default governs the integration and you hold `credential-proxy:call-own` " +
      "alone). Both flags describe a call passing that `connection_id`; with none passed and " +
      "`credential-proxy:call` held, an organization default applies first. A connection you " +
      "do not own is used when you pass its `connection_id` or an organization default " +
      "designates it. With `credential-proxy:call-own` alone, a connection another member " +
      "shared and a `call_permission_required` integration are reached through " +
      (ctx.runs ? "a run (run_and_wait). " : "an agent run only. ") +
      "With `query` or `integration`, `best_match` adds to the top result its `input_schema` " +
      "and its `usage` (how to call it and read its result), so a clear hit needs no other " +
      "call before call_integration_tool; search a tool's exact name to get them.",
    annotations: {
      title: "Search integration tools",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Free-text keywords matched against tool name, integration and description.",
        },
        integration: {
          type: "string",
          description: "Restrict to one integration, by package id (`@scope/name`).",
        },
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
    const listed = await listIntegrations(ctx);
    if ("refused" in listed) {
      ctx.observe({
        tool: "search_integration_tools",
        durationMs: performance.now() - start,
        method: "GET",
        path: CONNECTIONS_PATH,
        status: listed.refused.status,
        outcome: "invoked",
      });
      // The route's refusal, as `invoke_operation` would relay it.
      return jsonResult(listed.refused, true);
    }
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const integration = typeof args.integration === "string" ? args.integration : undefined;
    const rawLimit = typeof args.limit === "number" ? args.limit : DEFAULT_SEARCH_LIMIT;
    const limit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_SEARCH_LIMIT);
    const tokens = query.split(/\s+/).filter(Boolean);

    const searchedIntegrations = listed.integrations.filter(
      (entry) => integration === undefined || entry.id === integration,
    );
    const manifests = await Promise.all(
      searchedIntegrations.map((entry) => ctx.readManifest(entry.id)),
    );
    // One integration's listing at a time per slot, each bounded by the proxy's tool route.
    const perIntegration = await mapWithConcurrency(
      searchedIntegrations.map((entry, i) => ({ entry, manifest: manifests[i] })),
      CONCURRENCY,
      async ({ entry, manifest }) =>
        manifest ? (await integrationTools(ctx, entry, manifest)).tools : [],
    );
    const tools = perIntegration.flat();
    const matches = tools
      .map((tool, order) => ({ tool, order, score: scoreTool(tool, tokens) }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .map(({ tool }) => tool);
    const shown = matches.slice(0, limit);
    ctx.observe({
      tool: "search_integration_tools",
      durationMs: performance.now() - start,
      shownCount: shown.length,
      outcome: "invoked",
    });
    const top = shown[0];
    const searched = tokens.length > 0 || integration !== undefined;
    return jsonResult({
      total: matches.length,
      tools: shown.map(listedTool),
      ...(searched && top
        ? {
            best_match: {
              ...listedTool(top),
              usage: top.usage,
              input_schema: top.inputSchema,
            },
          }
        : {}),
    });
  };

  return { descriptor, handler };
}

const callSchema = z.strictObject({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  connection_id: z.uuid().optional(),
});

function buildCallIntegrationToolTool(ctx: ConnectionToolContext): AppstrateToolDefinition {
  const descriptor: Tool = {
    name: "call_integration_tool",
    description:
      "Call a tool search_integration_tools returned, by its `tool` name, with `arguments` " +
      "following its `input_schema`; its `usage` (in `best_match`, which a search by the " +
      "tool's exact name returns) says how to read the result. Arguments the tool does not " +
      "accept are refused before anything is sent. Call directly for deterministic or bulk " +
      "reads and writes" +
      (ctx.runs
        ? "; delegate to run_and_wait instead when the task needs judgement, several dependent " +
          "steps, an agent's configured tools, or, holding `credential-proxy:call-own` alone, a " +
          "connection another member shared."
        : "."),
    annotations: {
      title: "Call an integration tool",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tool", "arguments"],
      properties: {
        tool: {
          type: "string",
          description: "The tool's name, as search_integration_tools returned it.",
        },
        arguments: {
          type: "object",
          description: "The tool's arguments, following its `input_schema`.",
        },
        connection_id: {
          type: "string",
          description:
            "The connection to call with, one of the tool's `connections[].connection_id`. " +
            "Without it the proxy chooses as for an `api_call`, and refuses with the candidate " +
            "connections when several qualify. For an `api_call` tool, it applies to each " +
            "request that names no `connection_id` of its own.",
        },
      },
    },
  };

  const handler = async (
    args: Record<string, unknown>,
    extra: AppstrateRequestExtra,
  ): Promise<CallToolResult> => {
    const start = performance.now();
    // A malformed call is refused whole, before any request is sent.
    const refuse = (refusal: Refusal): CallToolResult => {
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        outcome: "rejected",
      });
      return refusalResult(refusal);
    };
    for (const name of ["tool", "arguments"] as const) {
      if (args[name] === undefined) {
        return refuse({
          code: "missing_argument",
          error: `${name} is required.`,
          arguments: [name],
        });
      }
    }
    const call = callSchema.safeParse(args);
    if (!call.success) return refuse(argumentsRefusal(call.error));

    const listed = await listIntegrations(ctx);
    if ("refused" in listed) {
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        method: "GET",
        path: CONNECTIONS_PATH,
        status: listed.refused.status,
        outcome: "invoked",
      });
      return jsonResult(listed.refused, true);
    }
    // A namespace holds no `__`: the name's first one ends it.
    const namespace = call.data.tool.split("__")[0];
    const integration = listed.integrations.find((entry) => entry.namespace === namespace);
    const manifest = integration ? await ctx.readManifest(integration.id) : null;
    const toolSet =
      integration && manifest
        ? await integrationTools(ctx, integration, manifest, call.data.connection_id)
        : undefined;
    const tool = toolSet?.tools.find((t) => t.name === call.data.tool);
    if (!tool && toolSet?.refusal) {
      // The remote server's listing was refused (connection, permission): the refusal says why.
      ctx.observe({
        tool: "call_integration_tool",
        durationMs: performance.now() - start,
        outcome: "invoked",
      });
      return jsonResult(toolSet.refusal, true);
    }
    if (!tool) {
      return refuse({
        code: "unknown_tool",
        error: `No integration tool named ${call.data.tool} is callable by you in this space.`,
        arguments: ["tool"],
        hint: "Take the name from search_integration_tools.",
      });
    }

    const required: unknown[] = Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required
      : [];
    for (const name of required) {
      if (typeof name !== "string") continue;
      if (call.data.arguments[name] === undefined) {
        return refuse({
          code: "missing_argument",
          error: `arguments.${name} is required.`,
          arguments: [`arguments.${name}`],
        });
      }
    }
    const parsed = tool.schema.safeParse(call.data.arguments);
    if (!parsed.success) return refuse(argumentsRefusal(parsed.error, ["arguments"]));
    const outcome = await tool.execute(parsed.data, extra, call.data.connection_id);
    if ("code" in outcome) return refuse(outcome);
    ctx.observe({
      tool: "call_integration_tool",
      durationMs: performance.now() - start,
      shownCount: outcome.shownCount,
      outcome: "invoked",
    });
    return outcome.result;
  };

  return { descriptor, handler };
}

/** Declared together, to a caller `McpSurface.proxies` holds for. */
export function buildConnectionTools(ctx: ConnectionToolContext): AppstrateToolDefinition[] {
  return [buildSearchIntegrationToolsTool(ctx), buildCallIntegrationToolTool(ctx)];
}
