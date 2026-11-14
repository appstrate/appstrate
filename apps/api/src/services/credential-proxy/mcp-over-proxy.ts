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
import { ApiError, badGateway } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { proxyProblem, upstreamFailureDetail } from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { trackAudit } from "../audit.ts";
import type { ProxyReach } from "../integration-connections.ts";
import type { ResolvedIntegrationVersion } from "../integration-service.ts";
import { getCredentialProxyLimits } from "../proxy-limits.ts";
import { recordConnectionCall, type ConnectionCall } from "./call-journal.ts";
import { proxyCall, ProxyCallError } from "./core.ts";

/** Who calls, as the call journal records it. */
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
  /** Bounds every exchange. */
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

/** Tools read from one server's `tools/list`, whatever its pages hold. */
export const MAX_LISTED_TOOLS = 500;
/** Bounds a server answering `nextCursor` forever with empty pages. */
export const MAX_LISTED_PAGES = 20;
/** The longest tool name read (MCP's own bound); a longer one is dropped. */
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * A server's `tools/list`, page by page, up to {@link MAX_LISTED_TOOLS} tools over at most
 * {@link MAX_LISTED_PAGES} pages; `truncated` when the server lists more.
 */
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

/** One exchange dispatched by an operation. */
interface Dispatched {
  /** The operation's own: its `tools/call`, or the first page of its `tools/list`. */
  own: boolean;
  /** Settles once the proxy answered or failed it. */
  done: Promise<void>;
  reached?: JournaledExchange;
}

export interface ProxiedMcpOperation {
  /** For `createMcpHttpClient`: each exchange through `proxyCall`. */
  fetch: typeof fetch;
  /** The deadline, or the operation failing: what every request of the client is bound by. */
  signal: AbortSignal;
  /**
   * `work`, unless an exchange fails the operation first: an answer over the exchange bound, or
   * the server refusing the connection's credential. The SDK may swallow either (an SSE stream
   * erroring) and wait for its timeout; the operation answers at once.
   */
  guard<T>(work: Promise<T>): Promise<T>;
  /** Writes the operation's journal row, once every exchange it dispatched has ended. */
  settle(): Promise<void>;
}

/**
 * One MCP operation spoken over the credential proxy: a `tools/list` listing or one `tools/call`.
 * The SDK echoes the server's own values (`Mcp-Session-Id`, `nextCursor`), so headers go
 * literally: no placeholder they carry reaches a credential.
 *
 * The call journal keeps one row per operation that reached upstream: its own exchange whatever
 * its outcome (a timeout included) once it reached the connection, else the last exchange that
 * did (a handshake refused, a transport failure after dispatch). An operation that reached
 * nothing (a catalog served from cache, a refusal before dispatch) writes none.
 */
export function proxiedMcpOperation(input: ProxiedMcpOperationInput): ProxiedMcpOperation {
  const { scope } = input;
  const ended = new AbortController();
  const signal = AbortSignal.any([input.deadline, ended.signal]);
  let failure: Error | undefined;
  const fail = (err: Error) => {
    if (failure) return;
    failure = err;
    ended.abort(err);
  };
  const failed = new Promise<never>((_, reject) => {
    ended.signal.addEventListener("abort", () => reject(failure), { once: true });
  });
  failed.catch(() => {});

  const dispatched: Dispatched[] = [];
  let lastReached: JournaledExchange | undefined;
  let settled = false;

  const fetchImpl = (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone GET stream carries server-initiated messages, which a bounded exchange never reads.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    // Nothing more leaves once the operation is over.
    signal.throwIfAborted();
    const method = init?.method ?? "POST";
    const href = target instanceof Request ? target.url : String(target);
    const body = typeof init?.body === "string" ? init.body : null;
    const started = Date.now();
    let markDone!: () => void;
    const exchange: Dispatched = {
      own: isOperationExchange(body) && !dispatched.some((d) => d.own),
      done: new Promise<void>((resolve) => (markDone = resolve)),
    };
    dispatched.push(exchange);
    const reached = (connectionId: string, outcome: string) => {
      exchange.reached = {
        connectionId,
        method,
        target: href,
        outcome,
        durationMs: Date.now() - started,
      };
      lastReached = exchange.reached;
    };
    const maxResponseBytes = Math.min(
      MAX_EXCHANGE_BYTES,
      getCredentialProxyLimits().max_response_bytes,
    );
    let result;
    try {
      result = await proxyCall({
        orgId: scope.orgId,
        spaceId: scope.spaceId,
        actor: input.actor,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        connectionNaming: "connection_id",
        reach: input.reach,
        ...(input.version ? { version: input.version } : {}),
        integrationId: input.integrationId,
        method,
        target: href,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body,
        literalHeaders: true,
        maxResponseBytes,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) reached(err.connectionId, err.code);
      throw err;
    } finally {
      markDone();
    }
    reached(result.connectionId, String(result.status));
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
      work.catch(() => {});
      try {
        return await Promise.race([work, failed]);
      } catch (err) {
        throw failure ?? err;
      }
    },
    settle: async () => {
      if (settled) return;
      settled = true;
      // An exchange still in flight ends by the deadline at the latest.
      await Promise.all(dispatched.map((d) => d.done));
      const row = dispatched.find((d) => d.own)?.reached ?? lastReached;
      if (!row) return;
      void trackAudit(
        recordConnectionCall({
          ...input.caller,
          ...row,
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          integrationId: input.integrationId,
          actor: input.actor,
          runId: null,
        }),
      );
    },
  };
}

/** Whether a JSON-RPC body is a `tools/call`, or a `tools/list` asking for no cursor. */
function isOperationExchange(body: string | null): boolean {
  if (body === null) return false;
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof message !== "object" || message === null) return false;
  const { method, params } = message as { method?: unknown; params?: { cursor?: unknown } };
  return method === "tools/call" || (method === "tools/list" && params?.cursor === undefined);
}

/** Characters kept of a server's JSON-RPC error message, untrusted text. */
const MAX_RPC_MESSAGE_CHARS = 512;

/**
 * The error a failed MCP operation answers: the proxy's own refusal as it is, a server fault as a
 * 502 naming the server's origin only (its message is untrusted text).
 *
 *   - `upstream_response_too_large`: an answer over the exchange bound;
 *   - `upstream_credential_rejected`: the server answered 401 or 403 to the connection's
 *     credential, with the proxy's `credential` verdict when its forced refresh judged it. For an
 *     integration declaring no auth, that is the server asking for one: `bad_gateway`;
 *   - `upstream_timeout` (504): no answer before the operation's deadline;
 *   - `upstream_mcp_error`: a JSON-RPC error the server answered, its `code` and bounded message.
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
    error: getErrorMessage(err),
  });
  const tooLarge = findCause(err, (e) => e instanceof McpExchangeTooLargeError);
  if (tooLarge instanceof McpExchangeTooLargeError) {
    return new ApiError({
      status: 502,
      code: "upstream_response_too_large",
      title: "Upstream Response Too Large",
      detail: `${server} answered with more than ${tooLarge.limit} bytes: ${input.tooLarge ?? "the answer is too large to read"}.`,
    });
  }
  const status = err instanceof McpCredentialRejectedError ? err.status : httpStatusOf(err);
  if (status === 401 || status === 403) {
    if (input.unauthenticated) {
      return badGateway(
        `${server} asks for a credential (HTTP ${status}), but the integration declares no authentication.`,
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
    });
  }
  if (isRequestTimeout(err) || findCause(err, (e) => e.name === "TimeoutError")) {
    return proxyProblem("upstream_timeout", upstreamFailureDetail(server, "upstream_timeout"));
  }
  const rpc = jsonRpcErrorOf(err);
  if (rpc) {
    return new ApiError({
      status: 502,
      code: "upstream_mcp_error",
      title: "Upstream MCP Error",
      detail: `${server} answered JSON-RPC error ${rpc.code}; \`mcp_error.message\` is its own text.`,
      extensions: {
        mcp_error: { code: rpc.code, message: rpc.message.slice(0, MAX_RPC_MESSAGE_CHARS) },
      },
    });
  }
  return badGateway(`${server} ${input.failed ?? "did not answer"}.`);
}
