// SPDX-License-Identifier: Apache-2.0

/**
 * MCP spoken over the credential proxy: each exchange of an MCP client is one `proxyCall`, so the
 * connection selection, `authorized_uris`, the egress guard and the 401 refresh are the proxy's.
 * Shared by the typed tools of a remote integration (`remote-tools.ts`) and the editor's server
 * sync (`integration-server-sync.ts`).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  httpStatusOf,
  isRequestTimeout,
  jsonRpcErrorOf,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { getErrorMessage } from "@appstrate/core/errors";
import type { Actor } from "../../lib/actor.ts";
import { credentialMember, type CredentialStatus } from "../../lib/credential-status-header.ts";
import { findCause } from "../../lib/error-cause.ts";
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
import { recordConnectionCall, type ConnectionCall } from "./call-journal.ts";
import { proxyCall, ProxyCallError } from "./core.ts";

export type ProxyCaller = Pick<ConnectionCall, "apiKeyId" | "authMethod" | "requestId">;

interface ProxiedMcpOperationInput {
  scope: SpaceScope;
  actor: Actor;
  integrationId: string;
  /** The connection, as a `connection_id` names it; the proxy selects one when omitted. */
  connectionId?: string;
  reach: ProxyReach;
  /** The version the exchange is authorized against; the latest published one when omitted. */
  version?: ResolvedIntegrationVersion;
  caller: ProxyCaller;
  deadline: AbortSignal;
}

/**
 * Per MCP exchange (a `tools/list` page or a tool result), bounded like an `api_call` body; the
 * proxy's `max_response_bytes` wins when lower.
 */
export const MAX_EXCHANGE_BYTES = 2 * 1024 * 1024;

/** An MCP exchange whose answer exceeded the bound it is read under: the server did answer. */
export class McpExchangeTooLargeError extends Error {
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

/** An exchange that reached a connection: its credential may have been sent. */
interface JournaledExchange {
  connectionId: string;
  method: string;
  target: string;
  outcome: string;
  durationMs: number;
}

interface JournalEntry {
  reached(connectionId: string, outcome: string): void;
  ended(): void;
}

/**
 * The journal row of one operation: the last exchange it dispatched that reached a connection,
 * whatever its outcome (a timeout included); none when nothing reached one (a catalog served from
 * cache, a refusal before dispatch). Registered with the audit drain at its first exchange, so a
 * shutdown waits for an operation outliving its request; written once every exchange has ended.
 */
function operationJournal(input: ProxiedMcpOperationInput) {
  const entries: { reached?: JournaledExchange; done: Promise<void> }[] = [];
  let release: (() => void) | undefined;
  let settled = false;
  const write = async () => {
    await Promise.all(entries.map((entry) => entry.done));
    const row = entries.findLast((entry) => entry.reached)?.reached;
    if (!row) return;
    await recordConnectionCall({
      ...input.caller,
      ...row,
      orgId: input.scope.orgId,
      spaceId: input.scope.spaceId,
      integrationId: input.integrationId,
      actor: input.actor,
      runId: null,
    });
  };
  return {
    /** `null` once settled: an exchange then (the session's close) is none of the operation's. */
    dispatch(method: string, target: string): JournalEntry | null {
      if (settled) return null;
      if (!release) {
        const released = new Promise<void>((resolve) => (release = resolve));
        void trackAudit(released.then(write));
      }
      const started = Date.now();
      let end!: () => void;
      const entry: (typeof entries)[number] = { done: new Promise((resolve) => (end = resolve)) };
      entries.push(entry);
      return {
        reached: (connectionId, outcome) => {
          entry.reached = {
            connectionId,
            method,
            target,
            outcome,
            durationMs: Date.now() - started,
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

export interface ProxiedMcpOperation {
  fetch: typeof fetch;
  /** The deadline, or the operation failing: what every request of the client is bound by. */
  signal: AbortSignal;
  /**
   * `work`, unless an exchange fails the operation first: an answer over the exchange bound, or
   * the server refusing the connection's credential. The SDK may swallow either (an SSE stream
   * erroring) and wait for its timeout; the operation answers at once.
   */
  guard<T>(work: Promise<T>): Promise<T>;
  settle(): void;
}

/**
 * One MCP operation spoken over the credential proxy: a `tools/list` listing or one `tools/call`,
 * journaled as one row ({@link operationJournal}). The SDK echoes the server's own values
 * (`Mcp-Session-Id`, `nextCursor`), so headers go literally: no placeholder they carry reaches a
 * credential.
 */
export function proxiedMcpOperation(input: ProxiedMcpOperationInput): ProxiedMcpOperation {
  const failed = new AbortController();
  const signal = AbortSignal.any([input.deadline, failed.signal]);
  const fail = (err: Error) => failed.abort(err);
  const journal = operationJournal(input);

  const fetchImpl = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone GET stream carries server-initiated messages, which a bounded exchange never reads.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    signal.throwIfAborted();
    const method = init?.method ?? "POST";
    const href = target instanceof Request ? target.url : String(target);
    const entry = journal.dispatch(method, href);
    const maxResponseBytes = Math.min(
      MAX_EXCHANGE_BYTES,
      getCredentialProxyLimits().max_response_bytes,
    );
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
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) {
        entry?.reached(err.connectionId, err.code);
      }
      throw err;
    } finally {
      entry?.ended();
    }
    entry?.reached(result.connectionId, String(result.status));
    if (result.status === 401 || result.status === 403) {
      fail(new McpCredentialRejectedError(result.status, result.credential));
    }
    // A body cut at the bound fails the operation, rather than handing the client half a message.
    const answered = result;
    const relayed =
      result.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush() {
            if (!answered.truncated) return;
            const err = new McpExchangeTooLargeError(maxResponseBytes);
            fail(err);
            throw err;
          },
        }),
      ) ?? null;
    return new Response(relayed, { status: result.status, headers: result.headers });
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
  };
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

/** A log record's fields that may carry server-authored text, each string bounded. */
export function untrustedFields(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? untrustedText(value) : value,
    ]),
  );
}

export function isCredentialRejection(err: unknown): boolean {
  const status = err instanceof McpCredentialRejectedError ? err.status : httpStatusOf(err);
  return status === 401 || status === 403;
}

/** JSON-RPC "Invalid params": the server refused the call's arguments or tool name. */
const JSON_RPC_INVALID_PARAMS = -32602;

/**
 * The error a failed MCP operation answers: the proxy's own refusal as it is, a server fault as a
 * problem naming the server's origin only, with its `Proxy-Status`. A 401 or 403 of a server whose
 * integration declares no auth is the server asking for one: `bad_gateway`.
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
  const protocolError = upstreamProxyStatus({ error: "http_protocol_error" });
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
        upstreamProxyStatus({ receivedStatus: status }),
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
  if (isRequestTimeout(err) || findCause(err, (e) => e.name === "TimeoutError")) {
    return proxyProblem("upstream_timeout", upstreamFailureDetail(server, "upstream_timeout"));
  }
  const rpc = jsonRpcErrorOf(err);
  if (rpc) {
    const mcpError = { code: rpc.code, message: untrustedText(rpc.message) };
    const detail = `${server} answered JSON-RPC error ${rpc.code}; \`mcp_error.message\` is its own text.`;
    return rpc.code === JSON_RPC_INVALID_PARAMS
      ? new ApiError({
          status: 422,
          code: "upstream_invalid_params",
          title: "Upstream Invalid Params",
          detail: `${detail} The server refused the arguments or the tool name.`,
          extensions: { mcp_error: mcpError },
          headers: upstreamProxyStatus({ error: "http_request_error" }),
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
