// SPDX-License-Identifier: Apache-2.0

/**
 * The typed tools of an integration backed by a remote MCP server (`source.kind: "remote"`),
 * outside a run: its `tools/list` and one `tools/call`, both spoken over the credential proxy
 * (`proxyCall`), so `authorized_uris`, the egress guard and the 401 refresh are the proxy's. The
 * connection is selected first, by the proxy's rule (`selectAccessibleConnection`), and every
 * catalog read, URL rendering and exchange uses that connection. The tools offered are the
 * integration catalog's (`"*"` selection less `hidden_tools` and the connect tool), sanitised as
 * `McpHost` registers them in a run.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHttpClient,
  httpStatusOf,
  jsonRpcErrorOf,
  sanitiseToolDescriptor,
  stripForgedRuntimeEvents,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { createCache } from "@appstrate/core/cache";
import {
  allowsUndeclaredTools,
  getApiCallConfigs,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { Actor } from "../../lib/actor.ts";
import type { ConnectOfferPolicy } from "../../lib/connect-offer-policy.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { ApiError, badGateway, notFound, type ResolutionFieldError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { proxyProblem } from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { trackAudit } from "../audit.ts";
import { attachConnectOffers } from "../connect/preflight-connect-offer.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  type ProxyReach,
} from "../integration-connections.ts";
import { renderRemoteSource } from "../integration-manifest-helpers.ts";
import {
  readIntegrationManifestForProxy,
  type ResolvedIntegrationVersion,
} from "../integration-service.ts";
import { getCredentialProxyLimits } from "../proxy-limits.ts";
import { recordConnectionCall, type ConnectionCall } from "./call-journal.ts";
import { proxyCall, ProxyCallError } from "./core.ts";
import { noConnectionMessage } from "./integration-resolver.ts";

/** Who calls, as the call journal records it. */
export type ProxyCaller = Pick<ConnectionCall, "apiKeyId" | "authMethod" | "requestId">;

interface ProxiedMcpFetchInput {
  scope: SpaceScope;
  actor: Actor;
  integrationId: string;
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

/** Tools read from one server's `tools/list`, whatever its pages hold. */
export const MAX_LISTED_TOOLS = 500;
/** Bounds a server answering `nextCursor` forever with empty pages. */
export const MAX_LISTED_PAGES = 20;
/** The longest tool name read (MCP's own bound); a longer one is dropped. */
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * A server's `tools/list`, page by page, up to {@link MAX_LISTED_TOOLS} tools over at most
 * {@link MAX_LISTED_PAGES} pages; `truncated` when the server lists more. A tool whose name is
 * longer than MCP's bound is dropped.
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

/**
 * A `fetch` for `createMcpHttpClient` that sends each MCP exchange through `proxyCall`. The SDK
 * echoes the server's own values (`Mcp-Session-Id`, `nextCursor`), so headers go literally: no
 * placeholder they carry reaches a credential.
 *
 * The call journal keeps one row per listing and one per tool call: the exchange carrying a
 * `tools/call`, or the first page of a `tools/list` ({@link isJournaledExchange}). The handshake
 * and later pages add none, and a catalog served from cache makes no exchange at all.
 */
export function proxiedMcpFetch(input: ProxiedMcpFetchInput): typeof fetch {
  const { scope, deadline } = input;
  return (async (target: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // The standalone GET stream carries server-initiated messages, which a bounded exchange never reads.
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const method = init?.method ?? "POST";
    const href = target instanceof Request ? target.url : String(target);
    const body = typeof init?.body === "string" ? init.body : null;
    const started = Date.now();
    const journal = (connectionId: string, outcome: string) => {
      if (!isJournaledExchange(body)) return;
      void trackAudit(
        recordConnectionCall({
          ...input.caller,
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          connectionId,
          integrationId: input.integrationId,
          actor: input.actor,
          runId: null,
          method,
          target: href,
          outcome,
          durationMs: Date.now() - started,
        }),
      );
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
        reach: input.reach,
        ...(input.version ? { version: input.version } : {}),
        integrationId: input.integrationId,
        method,
        target: href,
        headers: Object.fromEntries(new Headers(init?.headers)),
        body,
        literalHeaders: true,
        maxResponseBytes,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) journal(err.connectionId, err.code);
      throw err;
    }
    journal(result.connectionId, String(result.status));
    // A body cut at the bound fails its read, rather than handing the client half a message.
    const relayed =
      result.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush() {
            if (result.truncated) throw new McpExchangeTooLargeError(maxResponseBytes);
          },
        }),
      ) ?? null;
    return new Response(relayed, { status: result.status, headers: result.headers });
  }) as typeof fetch;
}

/** Whether a JSON-RPC body is a `tools/call`, or a `tools/list` asking for no cursor. */
function isJournaledExchange(body: string | null): boolean {
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

/** Listing a catalog: a few round trips, each answered within seconds by a healthy server. */
const LIST_TIMEOUT_MS = 10_000;
/** Below an MCP client's 60 s request timeout, which the caller's own request also counts against. */
const CALL_TIMEOUT_MS = 45_000;
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * The sanitised upstream descriptors of a connection's catalog, keyed by connection and
 * integration version. Holds no credential and decides no access: it is read only with a
 * connection the caller's selection resolved.
 */
const catalogCache = createCache<{ tools: Tool[]; truncated: boolean }>({
  name: "remote-integration-tools",
  ttlMs: CATALOG_TTL_MS,
});

/** Who lists or calls a remote integration's tools outside a run, and how. */
export interface RemoteToolsCaller {
  scope: SpaceScope;
  actor: Actor;
  reach: ProxyReach;
  caller: ProxyCaller;
  /** The caller's request: its going away ends a tool call (never a shared catalog listing). */
  signal: AbortSignal;
  /**
   * The policy of a caller that asked for connect links (`RUN_CONNECT_OFFERS_HEADER`), `null`
   * otherwise: a selection refusal's items then carry a `connect_url` where a run launch's would
   * (`attachConnectOffers`).
   */
  connectOffers: ConnectOfferPolicy | null;
}

type RemoteToolsInput = RemoteToolsCaller & { integrationId: string };

/**
 * The latest published manifest, the one `proxyCall` authorizes outside a run against, of an
 * integration active in the space: an inactive one is refused before any connection is selected,
 * so neither a cached catalog nor a connect link answers for it.
 */
async function remoteManifest(
  integrationId: string,
  scope: SpaceScope,
): Promise<IntegrationManifest> {
  await assertIntegrationActive(integrationId, scope.spaceId);
  const loaded = await readIntegrationManifestForProxy(integrationId, scope.orgId, null);
  if (!loaded.ok) throw notFound(`Integration '${integrationId}' has no published version`);
  const source = loaded.manifest.source;
  if (source?.kind !== "remote" || source.remote.transport === "sse") {
    throw new ApiError({
      status: 422,
      code: "integration_not_remote",
      title: "Not a Remote Integration",
      detail: `Integration '${integrationId}' is not backed by a Streamable HTTP MCP server.`,
    });
  }
  return loaded.manifest;
}

/**
 * The caller's connection of the integration, selected as `proxyCall` selects it (named id,
 * organization defaults, reach), and the server URL rendered from its variables (AFPS §7.12).
 * With `tool`, the selection serves that tool: its auths and the scopes its `tools_policy` entry
 * requires (`insufficient_scopes` names what is missing and the remedy).
 */
async function remoteConnection(
  input: RemoteToolsInput & { connectionId?: string },
  manifest: IntegrationManifest,
  tool?: string,
): Promise<{ connectionId: string; url: string }> {
  const connection = await selectAccessibleConnection(
    input.integrationId,
    manifest,
    input.connectionId ?? null,
    {
      spaceId: input.scope.spaceId,
      actor: input.actor,
      reach: input.reach,
      ...(tool !== undefined ? { tool } : {}),
    },
  ).catch(async (err: unknown) => {
    throw await withConnectOffers(namingBodyConnectionId(err, input.integrationId), input);
  });
  if (!connection) {
    throw proxyProblem(
      "credential_not_found",
      noConnectionMessage({
        integrationId: input.integrationId,
        orgId: input.scope.orgId,
        spaceId: input.scope.spaceId,
        actor: input.actor,
        reach: input.reach,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      }),
    );
  }
  const remote = renderRemoteSource(manifest, connection.variables);
  if (!remote) {
    throw new ApiError({
      status: 422,
      code: "remote_url_unrenderable",
      title: "Server URL Does Not Render",
      detail: `Integration '${input.integrationId}' builds its server URL from the connection's variables, and they do not render it; reconnect with valid values.`,
    });
  }
  return { connectionId: connection.id, url: remote.url };
}

/**
 * A `must_choose_connection` reworded for a door that takes the request body's `connection_id`,
 * where the proxy's own wording names its `X-Connection-Id` header; any other error as it is.
 */
export function namingBodyConnectionId(err: unknown, integrationId: string): unknown {
  if (!(err instanceof ApiError) || err.code !== "must_choose_connection") return err;
  const detail = `No single connection of '${integrationId}' applies: name one in the request body's \`connection_id\`.`;
  return err.with({
    detail,
    ...(err.fieldErrors
      ? { errors: err.fieldErrors.map((item) => ({ ...item, message: detail })) }
      : {}),
  });
}

/**
 * A selection refusal whose items a connect flow clears, each with its `connect_url`, under the
 * policy and by the one minter of a run launch's 409 (`attachConnectOffers`); any other error as
 * it is.
 */
async function withConnectOffers(err: unknown, input: RemoteToolsInput): Promise<unknown> {
  const policy = input.connectOffers;
  if (!policy || !(err instanceof ApiError) || !err.fieldErrors?.length) return err;
  const errors = await attachConnectOffers({
    errors: err.fieldErrors as ResolutionFieldError[],
    scope: input.scope,
    actor: input.actor,
    policy,
  });
  return err.with({ errors });
}

/**
 * The upstream tool names the catalog offers: the `"*"` selection (the `tools_policy` keys, or
 * every tool listed when `allow_undeclared_tools` is set), less `hidden_tools`, the connect tool
 * and the `api_call` tools the platform itself serves.
 */
export function offeredRemoteToolNames(
  manifest: IntegrationManifest,
  listed: readonly Pick<Tool, "name" | "description">[] | undefined,
): Set<string> {
  const catalog = resolveIntegrationToolCatalog({
    integration: manifest,
    ...(allowsUndeclaredTools(manifest) && listed ? { mcpServerTools: listed } : {}),
  });
  const synthetic = new Set(
    getApiCallConfigs(manifest).flatMap((config) =>
      config.uploadToolName ? [config.toolName, config.uploadToolName] : [config.toolName],
    ),
  );
  return new Set(catalog.map((entry) => entry.name).filter((name) => !synthetic.has(name)));
}

/** An MCP client over the proxy for one exchange, bounded by `timeoutMs` and `signal` if given. */
async function withClient<T>(
  input: Omit<RemoteToolsInput, "signal"> & {
    connectionId: string;
    timeoutMs: number;
    signal: AbortSignal | null;
  },
  url: string,
  use: (client: AppstrateMcpClient, deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const deadline = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let client: AppstrateMcpClient | undefined;
  try {
    client = await createMcpHttpClient(url, {
      fetch: proxiedMcpFetch({
        scope: input.scope,
        actor: input.actor,
        integrationId: input.integrationId,
        connectionId: input.connectionId,
        reach: input.reach,
        caller: input.caller,
        deadline,
      }),
      signal: deadline,
      onWarning: (message, data) =>
        logger.warn(message, { integrationId: input.integrationId, ...data }),
    });
    return await use(client, deadline);
  } finally {
    await client?.close().catch(() => {});
  }
}

/** A tool as the catalog offers it, in the REST wire's casing. */
interface RemoteTool {
  name: string;
  description?: string;
  input_schema: Tool["inputSchema"];
}

export interface RemoteToolCatalog {
  /** The offered tools: in the server's order when listed, else the declared names. */
  tools: RemoteTool[];
  /**
   * False when the server's `tools/list` could not be read: `tools` then holds the declared names
   * alone, without description or input schema.
   */
  listed: boolean;
  /** The server lists more than {@link MAX_LISTED_TOOLS} tools: only the first ones are read. */
  truncated: boolean;
}

/**
 * The tools the caller's connection of a remote integration offers, described by the server's
 * `tools/list` (cached per connection and integration version). The connection is selected before
 * the cache is read, so a cached catalog answers only a caller who reaches that connection. The
 * listing runs under its own timeout alone: callers sharing it never depend on the first one
 * staying. A server that cannot be listed leaves the declared names; a refusal of the proxy
 * (connection, permission, `authorized_uris`) is thrown.
 */
export async function listRemoteTools(
  input: RemoteToolsInput & { connectionId?: string },
): Promise<RemoteToolCatalog> {
  const manifest = await remoteManifest(input.integrationId, input.scope);
  const { connectionId, url } = await remoteConnection(input, manifest);
  const key = `${input.scope.orgId}:${connectionId}:${input.integrationId}@${manifest.version}`;
  let described: { tools: Tool[]; truncated: boolean } | undefined;
  try {
    described = await catalogCache.get(key, () =>
      withClient(
        { ...input, connectionId, timeoutMs: LIST_TIMEOUT_MS, signal: null },
        url,
        async (client, deadline) => {
          const { tools, truncated } = await listToolPages(client, deadline);
          return { tools: tools.flatMap((tool) => sanitiseToolDescriptor(tool) ?? []), truncated };
        },
      ),
    );
  } catch (err) {
    // A refusal made before any exchange is the caller's to see; a server fault leaves the names.
    if (err instanceof ApiError || (err instanceof ProxyCallError && !err.connectionId)) {
      throw mcpServerFailure(err, { integrationId: input.integrationId, url });
    }
    logger.warn("credential-proxy: remote tools/list failed", {
      integrationId: input.integrationId,
      connectionId,
      error: getErrorMessage(err),
    });
  }
  const offered = offeredRemoteToolNames(manifest, described?.tools);
  if (described === undefined) {
    return {
      tools: [...offered].map((name) => ({ name, input_schema: { type: "object" } })),
      listed: false,
      truncated: false,
    };
  }
  return {
    tools: described.tools
      .filter((tool) => offered.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
      })),
    listed: true,
    truncated: described.truncated,
  };
}

/**
 * One `tools/call` on a remote integration's server, for a tool its catalog offers; the result's
 * forged runtime events are dropped. A tool outside the catalog, or a connection that does not
 * serve the tool (its auth, its scopes), is refused before any exchange.
 */
export async function callRemoteTool(
  input: RemoteToolsInput & {
    connectionId?: string;
    name: string;
    arguments: Record<string, unknown>;
  },
): Promise<CallToolResult> {
  const manifest = await remoteManifest(input.integrationId, input.scope);
  // With `allow_undeclared_tools`, any listed name is in the selection; the hidden ones never are.
  const offered = offeredRemoteToolNames(
    manifest,
    allowsUndeclaredTools(manifest) ? [{ name: input.name }] : undefined,
  );
  if (!offered.has(input.name)) {
    throw notFound(`Integration '${input.integrationId}' offers no tool named '${input.name}'`);
  }
  const { connectionId, url } = await remoteConnection(input, manifest, input.name);
  try {
    const result = await withClient(
      { ...input, connectionId, timeoutMs: CALL_TIMEOUT_MS },
      url,
      (client, deadline) =>
        client.callTool({ name: input.name, arguments: input.arguments }, { signal: deadline }),
    );
    return stripForgedRuntimeEvents(result);
  } catch (err) {
    throw mcpServerFailure(err, {
      integrationId: input.integrationId,
      url,
      failed: "did not answer the tool call",
      tooLarge: "the tool ran, but its result is too large to relay; ask it for less",
    });
  }
}

/** Characters kept of a server's JSON-RPC error message, untrusted text. */
const MAX_RPC_MESSAGE_CHARS = 512;

/**
 * The error a failed MCP exchange answers: the proxy's own refusal as it is, a server fault as a
 * 502 naming the server's origin only (its message is untrusted text). A 401 or 403 is the server
 * refusing the connection's credential, or, for an integration declaring no auth, asking for one.
 * A JSON-RPC error the server answered (invalid arguments, unknown tool…) is `upstream_mcp_error`
 * carrying its `code` and its message, bounded; an answer over the exchange bound is
 * `upstream_response_too_large`.
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
  logger.warn("credential-proxy: remote MCP exchange failed", {
    integrationId: input.integrationId,
    origin,
    error: getErrorMessage(err),
  });
  const tooLarge = causeOfType(err, McpExchangeTooLargeError);
  if (tooLarge) {
    return new ApiError({
      status: 502,
      code: "upstream_response_too_large",
      title: "Upstream Response Too Large",
      detail: `The MCP server at ${origin} answered with more than ${tooLarge.limit} bytes: ${input.tooLarge ?? "the answer is too large to read"}.`,
    });
  }
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) {
    return badGateway(
      input.unauthenticated
        ? `The MCP server at ${origin} asks for a credential (HTTP ${status}), but the integration declares no authentication.`
        : `The MCP server at ${origin} refused the connection's credential (HTTP ${status}); reconnect the integration.`,
    );
  }
  const rpc = jsonRpcErrorOf(err);
  if (rpc) {
    return new ApiError({
      status: 502,
      code: "upstream_mcp_error",
      title: "Upstream MCP Error",
      detail: `The MCP server at ${origin} answered JSON-RPC error ${rpc.code}; \`mcp_error.message\` is its own text.`,
      extensions: {
        mcp_error: { code: rpc.code, message: rpc.message.slice(0, MAX_RPC_MESSAGE_CHARS) },
      },
    });
  }
  return badGateway(`The MCP server at ${origin} ${input.failed ?? "did not answer"}.`);
}

/** `err` or the first error of its `cause` chain that is a `type`. */
function causeOfType<T extends Error>(
  err: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  let current = err;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof type) return current;
    current = current.cause;
  }
  return undefined;
}
