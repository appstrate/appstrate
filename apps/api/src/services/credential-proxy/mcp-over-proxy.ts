// SPDX-License-Identifier: Apache-2.0

/**
 * One MCP operation of a remote integration's server: over the credential proxy, each exchange
 * one `proxyCall`, so the connection selection, `authorized_uris`, the egress guard and the 401
 * refresh are the proxy's; or, for an unauthenticated integration (AFPS §7.2), with nothing to
 * inject, directly, egress-guarded on every hop. Shared by the typed tools of a remote integration
 * (`remote-tools.ts`) and the editor's server sync (`integration-server-sync.ts`).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  httpStatusOf,
  isMcpOperationExchange,
  isRequestTimeout,
  jsonRpcErrorOf,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { getErrorMessage } from "@appstrate/core/errors";
import { SsrfBlockedError } from "@appstrate/core/ssrf";
import { templateHost } from "@appstrate/afps-runtime/resolvers";
import type { Actor } from "../../lib/actor.ts";
import { credentialMember, type CredentialStatus } from "../../lib/credential-status-header.ts";
import { findCause } from "@appstrate/core/error-cause";
import { egressFetchImpl, isCleartextToUntrustedHost } from "../../lib/egress-host-guard.ts";
import { ApiError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import {
  proxyProblem,
  upstreamFailureDetail,
  upstreamProxyStatus,
} from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { trackAudit } from "../audit.ts";
import type { ProxyReach } from "../integration-connections.ts";
import type { ResolvedIntegrationVersion } from "../integration-service.ts";
import { getCredentialProxyLimits } from "../proxy-limits.ts";
import { recordConnectionCalls, type ProxyCaller } from "./call-journal.ts";
import { bodyReadError, proxyCall, ProxyCallError } from "./core.ts";

interface McpOperationInput {
  scope: SpaceScope;
  actor: Actor;
  integrationId: string;
  caller: ProxyCaller;
  deadline: AbortSignal;
}

interface ProxiedMcpOperationInput extends McpOperationInput {
  /** The connection, as a `connection_id` names it; the proxy selects one when omitted. */
  connectionId?: string;
  reach: ProxyReach;
  /** The version the exchange is authorized against; the latest published one when omitted. */
  version?: ResolvedIntegrationVersion;
}

/**
 * Per MCP exchange (a `tools/list` page or a tool result), bounded like an `api_call` body; the
 * proxy's `max_response_bytes` wins when lower ({@link exchangeBound}).
 */
const MAX_EXCHANGE_BYTES = 2 * 1024 * 1024;

/** The bound an MCP answer is read under, on either path. */
function exchangeBound(): number {
  return Math.min(MAX_EXCHANGE_BYTES, getCredentialProxyLimits().max_response_bytes);
}

/** An MCP exchange whose answer exceeded the bound it is read under: the server did answer. */
class McpExchangeTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`an MCP answer exceeds ${limit} bytes`);
    this.name = "McpExchangeTooLargeError";
  }
}

/** The server refused the connection's credential (HTTP 401 or 403). */
class McpCredentialRejectedError extends Error {
  constructor(
    readonly status: number,
    /** The proxy's verdict after its forced refresh, on a 401 it judged. */
    readonly credential: CredentialStatus | undefined,
  ) {
    super(`the MCP server refused the connection's credential (HTTP ${status})`);
    this.name = "McpCredentialRejectedError";
  }
}

export const MAX_LISTED_TOOLS = 500;
/** Bounds a server answering `nextCursor` forever with empty pages. */
export const MAX_LISTED_PAGES = 20;
/** The longest tool name read (MCP's own bound); a longer one is dropped. */
const MAX_TOOL_NAME_LENGTH = 128;

/** A server's `tools/list`, page by page, within the bounds above. */
export async function listToolPages(
  client: AppstrateMcpClient,
  signal: AbortSignal,
): Promise<{ tools: Tool[]; truncated: boolean }> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LISTED_PAGES; page++) {
    const res = await client.listToolsPage({ ...(cursor ? { cursor } : {}), signal });
    for (const tool of res.tools) {
      if (tool.name.length <= MAX_TOOL_NAME_LENGTH) tools.push(tool);
      else
        logger.warn("credential-proxy: MCP tool name too long, dropped", {
          length: tool.name.length,
        });
    }
    cursor = res.nextCursor;
    if (!cursor || tools.length >= MAX_LISTED_TOOLS) break;
  }
  return {
    tools: tools.slice(0, MAX_LISTED_TOOLS),
    truncated: tools.length > MAX_LISTED_TOOLS || !!cursor,
  };
}

/**
 * An exchange that reached the server, or may have: through a connection, its credential may
 * have been sent; `null` on the direct path, which sends none.
 */
interface JournaledExchange {
  connectionId: string | null;
  method: string;
  host: string;
  outcome: string;
  durationMs: number;
  calledAt: Date;
}

interface JournalEntry {
  reached(connectionId: string | null, outcome: string): void;
  ended(): void;
}

/**
 * The journal row of one operation: the last exchange of the operation itself (the `tools/call`,
 * a `tools/list` page) that reached the server, else the last exchange that did, whatever its
 * outcome (a timeout included); none when nothing reached it (a catalog served from cache, a
 * refusal before dispatch). Registered with the audit drain at its first exchange, so a shutdown
 * waits for an operation outliving its request; written once every exchange has ended.
 */
function operationJournal(input: McpOperationInput) {
  const entries: { reached?: JournaledExchange; operation: boolean; done: Promise<void> }[] = [];
  let release: (() => void) | undefined;
  let settled = false;
  const write = async () => {
    await Promise.all(entries.map((entry) => entry.done));
    const row = (
      entries.findLast((entry) => entry.reached && entry.operation) ??
      entries.findLast((entry) => entry.reached)
    )?.reached;
    if (!row) return;
    await recordConnectionCalls([
      {
        ...input.caller,
        ...row,
        orgId: input.scope.orgId,
        spaceId: input.scope.spaceId,
        integrationId: input.integrationId,
        actor: input.actor,
        runId: null,
      },
    ]);
  };
  return {
    /** `null` once settled: an exchange then (the session's close) is none of the operation's. */
    dispatch(method: string, target: string, operation: boolean): JournalEntry | null {
      if (settled) return null;
      if (!release) {
        const released = new Promise<void>((resolve) => (release = resolve));
        void trackAudit(released.then(write));
      }
      const started = Date.now();
      let end!: () => void;
      const entry: (typeof entries)[number] = {
        operation,
        done: new Promise((resolve) => (end = resolve)),
      };
      entries.push(entry);
      return {
        reached: (connectionId, outcome) => {
          entry.reached = {
            connectionId,
            method,
            host: templateHost(target),
            outcome,
            durationMs: Date.now() - started,
            calledAt: new Date(started),
          };
        },
        ended: end,
      };
    },
    settle(): void {
      settled = true;
      release?.();
    },
  };
}

export interface McpOperation {
  fetch: typeof fetch;
  /** The deadline, or the operation failing: what every request of the client is bound by. */
  signal: AbortSignal;
  /**
   * `work`, unless an exchange fails the operation first: an answer over the exchange bound, or
   * the server refusing the connection's credential (proxied path). The SDK may swallow either
   * (an SSE stream erroring) and wait for its timeout; the operation answers at once.
   */
  guard<T>(work: Promise<T>): Promise<T>;
  settle(): void;
  /** The HTTP status of the last exchange the server answered, if any did. */
  receivedStatus(): number | undefined;
}

/** One exchange's request, and the operation's hooks into it. */
interface Exchange {
  method: string;
  href: string;
  init: RequestInit | undefined;
  /** The request's own signal joined to the operation's. */
  signal: AbortSignal;
  /** Journals the exchange as having reached the server. */
  reached(connectionId: string | null, outcome: string): void;
  /** Fails the whole operation (see {@link McpOperation.guard}). */
  fail(err: Error): void;
}

/**
 * The operation around a transport: the standalone GET stream refused (it carries
 * server-initiated messages, which a bounded exchange never reads), every exchange journaled
 * ({@link operationJournal}). The SDK echoes the server's own values (`Mcp-Session-Id`,
 * `nextCursor`), so headers go literally.
 */
function mcpOperation(
  input: McpOperationInput,
  transport: (exchange: Exchange) => Promise<Response>,
): McpOperation {
  const failed = new AbortController();
  const signal = AbortSignal.any([input.deadline, failed.signal]);
  const fail = (err: Error) => failed.abort(err);
  const journal = operationJournal(input);
  let receivedStatus: number | undefined;

  const fetchImpl = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    signal.throwIfAborted();
    const method = init?.method ?? "POST";
    const href = target instanceof Request ? target.url : String(target);
    // Nothing between the entry's registration and the `finally` that ends it can throw.
    const entry = journal.dispatch(method, href, isMcpOperationExchange(init?.body));
    try {
      const res = await transport({
        method,
        href,
        init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        reached: (connectionId, outcome) => entry?.reached(connectionId, outcome),
        fail,
      });
      receivedStatus = res.status;
      return res;
    } finally {
      entry?.ended();
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    signal,
    guard: async (work) => {
      try {
        return await untilAborted(work, failed.signal);
      } catch (err) {
        throw failed.signal.aborted ? failed.signal.reason : err;
      }
    },
    settle: journal.settle,
    receivedStatus: () => receivedStatus,
  };
}

/**
 * One MCP operation spoken over the credential proxy: a `tools/list` listing or one `tools/call`,
 * journaled as one row. No placeholder the literal headers carry reaches a credential.
 */
export function proxiedMcpOperation(input: ProxiedMcpOperationInput): McpOperation {
  return mcpOperation(input, async ({ method, href, init, signal, reached, fail }) => {
    const maxResponseBytes = exchangeBound();
    let result;
    try {
      result = await proxyCall({
        orgId: input.scope.orgId,
        spaceId: input.scope.spaceId,
        actor: input.actor,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        connectionNaming: "connection_id",
        reach: input.reach,
        ...(input.version ? { version: input.version } : {}),
        integrationId: input.integrationId,
        method,
        target: href,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: typeof init?.body === "string" ? init.body : null,
        literalHeaders: true,
        maxResponseBytes,
        signal,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) reached(err.connectionId, err.code);
      throw err;
    }
    reached(result.connectionId, String(result.status));
    if (result.status === 401 || result.status === 403) {
      fail(new McpCredentialRejectedError(result.status, result.credential));
    }
    const answered = result;
    const relayed = relayAnswer(result.body, {
      request: init?.body,
      headers: result.headers,
      bound: maxResponseBytes,
      truncated: () => answered.truncated === true,
      readFailure: (err) => bodyReadError(err, answered.redactedHost, answered.connectionId),
      fail,
    });
    return new Response(relayed, { status: result.status, headers: result.headers });
  });
}

/** The id of the JSON-RPC request `body` carries, if it is one: a notification awaits none. */
function awaitedResponseId(body: RequestInit["body"]): string | number | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const message: unknown = JSON.parse(body);
    if (typeof message !== "object" || message === null || !("method" in message)) return undefined;
    const id = (message as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an event stream's `data` carries the JSON-RPC response to request `id`. */
function answersRequest(data: string, id: string | number): boolean {
  try {
    const message: unknown = JSON.parse(data);
    return (
      typeof message === "object" &&
      message !== null &&
      ("result" in message || "error" in message) &&
      (message as { id?: unknown }).id === id
    );
  } catch {
    return false;
  }
}

/**
 * An answer's body, relayed to the MCP client. Past `bound` (or cut there, `truncated`) it fails
 * the operation; failing mid-read, it fails it too while the response the request awaits has not
 * arrived (a JSON body not ended, an event stream before the event answering its id), since the
 * SDK swallows an event stream's error and would wait for its timeout. Once answered, or for a
 * notification, a broken stream only errors itself: what it answered stands.
 */
function relayAnswer(
  body: ReadableStream<Uint8Array> | null,
  opts: {
    request: RequestInit["body"];
    headers: Headers;
    bound: number;
    truncated?: () => boolean;
    readFailure: (err: unknown) => Error;
    fail: (err: Error) => void;
  },
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  const awaited = awaitedResponseId(opts.request);
  const eventStream = opts.headers.get("content-type")?.includes("text/event-stream") === true;
  const decoder = new TextDecoder();
  let answered = awaited === undefined;
  let pending = "";
  let read = 0;
  /** Scans the complete events of `chunk` for the response to the awaited id. */
  const scan = (chunk: Uint8Array) => {
    if (answered || !eventStream) return;
    pending += decoder.decode(chunk, { stream: true });
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop() ?? "";
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data && answersRequest(data, awaited!)) answered = true;
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const failWith = (err: Error) => {
        opts.fail(err);
        controller.error(err);
        void reader.cancel(err).catch(() => {});
      };
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (answered) return controller.error(err);
        return failWith(opts.readFailure(err));
      }
      if (chunk.done) {
        if (opts.truncated?.()) return failWith(new McpExchangeTooLargeError(opts.bound));
        return controller.close();
      }
      read += chunk.value.byteLength;
      if (read > opts.bound) return failWith(new McpExchangeTooLargeError(opts.bound));
      scan(chunk.value);
      controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** The direct path's egress options, beside the guard's own per-hop host check. */
const DIRECT_EGRESS = {
  // Not `validateHop`: declaring one makes the guard drop the body on a same-host redirect.
  returnRedirect: (url: URL, hop: number) => {
    if (isCleartextToUntrustedHost(url)) {
      throw new SsrfBlockedError(url.hostname, "blocked-scheme", hop);
    }
    return false;
  },
  sensitiveHeaders: ["mcp-session-id"],
} as const satisfies Parameters<typeof egressFetchImpl>[0];

/** @internal Test-only: the redirect rules, for a guard driven with injected DNS and transport. */
export const _directEgressOptionsForTesting = DIRECT_EGRESS;

/**
 * An unauthenticated integration's operation (AFPS §7.2): nothing injected, the egress guard and
 * its https floor on every hop; a 307/308 keeps the body on the same host only (JSON-RPC
 * arguments may be user data), `Mcp-Session-Id` stays with its origin; `beforeExchange` mirrors
 * the proxy's per-exchange activation check; a challenge flags nothing, there is no connection.
 */
export function directMcpOperation(
  input: McpOperationInput & { beforeExchange?: () => Promise<void> },
): McpOperation {
  const egressFetch = egressFetchImpl(DIRECT_EGRESS);
  return mcpOperation(input, async ({ href, init, signal, reached, fail }) => {
    const target = new URL(href);
    /** The typed failure to throw, journaled when a request may have been sent. */
    const failed = (err: unknown): ProxyCallError => {
      const failure = directFailure(err, target.origin);
      if (failure.sent) reached(null, failure.code);
      return failure;
    };
    await input.beforeExchange?.();
    if (isCleartextToUntrustedHost(target)) {
      throw failed(new SsrfBlockedError(target.hostname, "blocked-scheme", 0));
    }
    const bound = exchangeBound();
    let res;
    try {
      res = await egressFetch(href, { ...init, signal });
    } catch (err) {
      throw failed(err);
    }
    reached(null, String(res.status));
    // The journal keeps the status received: a body failing later is not journaled again.
    const relayed = relayAnswer(res.body, {
      request: init?.body,
      headers: res.headers,
      bound,
      readFailure: (err) => directFailure(err, target.origin),
      fail,
    });
    return new Response(relayed, { status: res.status, headers: res.headers });
  });
}

/**
 * A failed direct exchange as the proxy's typed error, as `toProxyCallError` (`core.ts`) types
 * the proxied path's: `sent` unless the first hop was refused or could not be resolved.
 */
function directFailure(err: unknown, origin: string): ProxyCallError {
  const server = `The MCP server at ${origin}`;
  if (err instanceof SsrfBlockedError && err.reason !== "too-many-redirects") {
    const unresolvable = err.reason === "resolution-failed";
    const refused = unresolvable ? "could not be resolved" : "the egress guard refuses";
    const detail =
      err.hop > 0
        ? `${server} redirected to ${err.host}, which ${refused}.`
        : unresolvable
          ? upstreamFailureDetail(server, "upstream_unresolvable")
          : `${server} is refused by the egress guard.`;
    return new ProxyCallError(
      unresolvable ? "upstream_unresolvable" : "blocked_target",
      detail,
      undefined,
      err.hop > 0,
    );
  }
  const code = isTimeout(err) ? "upstream_timeout" : "upstream_unreachable";
  return new ProxyCallError(code, upstreamFailureDetail(server, code), undefined, true);
}

/** A deadline reached, at any depth of the error's causes. */
function isTimeout(err: unknown): boolean {
  return findCause(err, (e) => e.name === "TimeoutError") !== undefined;
}

/** `work`'s outcome, or `signal`'s reason once it aborts first; `work` then settles unobserved. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Characters kept of any text a server wrote, as a model reads it and as it is logged. */
const MAX_UNTRUSTED_CHARS = 512;

export function untrustedText(text: string): string {
  return text.slice(0, MAX_UNTRUSTED_CHARS);
}

/**
 * A log record's fields that may carry server-authored values, each bounded whole: a string cut,
 * any other value serialised then cut.
 */
export function untrustedFields(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      untrustedText(typeof value === "string" ? value : serialised(value)),
    ]),
  );
}

function serialised(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isCredentialRejection(err: unknown): boolean {
  const status = err instanceof McpCredentialRejectedError ? err.status : httpStatusOf(err);
  return status === 401 || status === 403;
}

/** JSON-RPC "Invalid params": to a `tools/call`, the server refused its arguments or tool name. */
const JSON_RPC_INVALID_PARAMS = -32602;

/**
 * The error a failed MCP operation answers: the proxy's own refusal as it is, a server fault as a
 * problem naming the server's origin only, with its `Proxy-Status`. A 401 or 403 of a server whose
 * integration declares no auth is the server asking for one: `bad_gateway`. A JSON-RPC error is
 * `upstream_mcp_error`, but Invalid params answered to the `tools/call` itself, which refuses the
 * caller's own request: `upstream_invalid_params`.
 */
export function mcpServerFailure(
  err: unknown,
  input: {
    integrationId: string;
    url: string;
    unauthenticated?: boolean;
    failed?: string;
    /** Completes the detail of an answer over the exchange bound. */
    tooLarge?: string;
    /** The failure came from the `tools/call` exchange, the session already open. */
    toolCall?: boolean;
    /** The HTTP status of the last exchange the server answered. */
    receivedStatus?: number;
  },
): Error {
  if (err instanceof ApiError) return err;
  if (err instanceof ProxyCallError) return proxyProblem(err.code, err.message);
  const origin = URL.parse(input.url)?.origin;
  const server = `The MCP server at ${origin}`;
  logger.warn("credential-proxy: remote MCP exchange failed", {
    integrationId: input.integrationId,
    origin,
    error: untrustedText(getErrorMessage(err)),
  });
  // A response generated from the server's answer: its HTTP status, when one was received.
  const protocolError = upstreamProxyStatus({
    error: "http_protocol_error",
    ...(input.receivedStatus !== undefined ? { receivedStatus: input.receivedStatus } : {}),
  });
  const tooLarge = findCause(err, (e) => e instanceof McpExchangeTooLargeError);
  if (tooLarge instanceof McpExchangeTooLargeError) {
    return new ApiError({
      status: 502,
      code: "upstream_response_too_large",
      title: "Upstream Response Too Large",
      detail: `${server} answered with more than ${tooLarge.limit} bytes: ${input.tooLarge ?? "the answer is too large to read"}.`,
      headers: upstreamProxyStatus({ error: "http_response_body_size" }),
    });
  }
  const status = err instanceof McpCredentialRejectedError ? err.status : httpStatusOf(err);
  if (status === 401 || status === 403) {
    if (input.unauthenticated) {
      return gatewayFault(
        `${server} asks for a credential (HTTP ${status}), but the integration declares no authentication.`,
        upstreamProxyStatus({ error: "http_protocol_error", receivedStatus: status }),
      );
    }
    const credential = err instanceof McpCredentialRejectedError ? err.credential : undefined;
    return new ApiError({
      status: 502,
      code: "upstream_credential_rejected",
      title: "Upstream Credential Rejected",
      detail:
        `${server} refused the connection's credential (HTTP ${status})` +
        (credential?.status === "needs_reconnection"
          ? ": the connection is now flagged for reconnection, and its owner must reconnect it."
          : ": the credential may lack a permission the server requires, or have been revoked; reconnecting the integration renews it."),
      extensions: {
        upstream_status: status,
        ...(credential ? { credential: credentialMember(credential) } : {}),
      },
      headers: upstreamProxyStatus({ receivedStatus: status }),
    });
  }
  if (isRequestTimeout(err) || isTimeout(err)) {
    return proxyProblem("upstream_timeout", upstreamFailureDetail(server, "upstream_timeout"));
  }
  const rpc = jsonRpcErrorOf(err);
  if (rpc) {
    const mcpError = { code: rpc.code, message: untrustedText(rpc.message) };
    const detail = `${server} answered JSON-RPC error ${rpc.code}; \`mcp_error.message\` is its own text.`;
    // The server answered valid HTTP carrying a JSON-RPC error: refused params are the
    // caller's request (`http_request_error`), any other error the server's (`http_protocol_error`).
    return rpc.code === JSON_RPC_INVALID_PARAMS && input.toolCall
      ? new ApiError({
          status: 422,
          code: "upstream_invalid_params",
          title: "Upstream Invalid Params",
          detail: `${detail} The server refused the arguments or the tool name.`,
          extensions: { mcp_error: mcpError },
          headers: upstreamProxyStatus({
            error: "http_request_error",
            ...(input.receivedStatus !== undefined ? { receivedStatus: input.receivedStatus } : {}),
          }),
        })
      : new ApiError({
          status: 502,
          code: "upstream_mcp_error",
          title: "Upstream MCP Error",
          detail,
          extensions: { mcp_error: mcpError },
          headers: protocolError,
        });
  }
  return gatewayFault(`${server} ${input.failed ?? "did not answer"}.`, protocolError);
}

function gatewayFault(detail: string, headers: Record<string, string>): ApiError {
  return new ApiError({ status: 502, code: "bad_gateway", title: "Bad Gateway", detail, headers });
}
