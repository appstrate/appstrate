// SPDX-License-Identifier: Apache-2.0

/**
 * The typed tools of an integration backed by a remote MCP server (`source.kind: "remote"`),
 * outside a run: its `tools/list` and one `tools/call`, both spoken over the credential proxy
 * (`proxyCall`), so connection selection, `authorized_uris`, the egress guard and the 401 refresh
 * are the proxy's. The tools offered are the integration catalog's (`"*"` selection less
 * `hidden_tools` and the connect tool), sanitised as `McpHost` registers them in a run.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHttpClient,
  httpStatusOf,
  sanitiseToolDescriptor,
  stripForgedRuntimeEvents,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { isVariableTemplate } from "@appstrate/afps-shared/connection-variables";
import { createCache } from "@appstrate/core/cache";
import {
  getApiCallConfigs,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { Actor } from "../../lib/actor.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { ApiError, badGateway, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { proxyProblem } from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { trackAudit } from "../audit.ts";
import type { ProxyReach } from "../integration-connections.ts";
import {
  readIntegrationManifestForProxy,
  type ResolvedIntegrationVersion,
} from "../integration-service.ts";
import { getCredentialProxyLimits } from "../proxy-limits.ts";
import { recordConnectionCall, type ConnectionCall } from "./call-journal.ts";
import { proxyCall, ProxyCallError } from "./core.ts";

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
  /** Per exchange, below the proxy's `max_response_bytes` (the lower of the two applies). */
  maxExchangeBytes: number;
  /** Whether an exchange, by its JSON-RPC body, gets a call-journal row. */
  journals: (body: string | null) => boolean;
}

/**
 * A `fetch` for `createMcpHttpClient` that sends each MCP exchange through `proxyCall`. The SDK
 * echoes the server's own values (`Mcp-Session-Id`, `nextCursor`), so headers go literally: no
 * placeholder they carry reaches a credential.
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
      if (!input.journals(body)) return;
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
        maxResponseBytes: Math.min(
          input.maxExchangeBytes,
          getCredentialProxyLimits().max_response_bytes,
        ),
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
    } catch (err) {
      if (err instanceof ProxyCallError && err.connectionId) journal(err.connectionId, err.code);
      throw err;
    }
    journal(result.connectionId, String(result.status));
    return new Response(result.body, { status: result.status, headers: result.headers });
  }) as typeof fetch;
}

/** Whether a JSON-RPC body is a `tools/call` request: the exchange the journal keeps a row of. */
function isToolsCall(body: string | null): boolean {
  if (body === null) return false;
  try {
    const message: unknown = JSON.parse(body);
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { method?: unknown }).method === "tools/call"
    );
  } catch {
    return false;
  }
}

/** Listing a catalog: a few round trips, each answered within seconds by a healthy server. */
const LIST_TIMEOUT_MS = 10_000;
/** Below an MCP client's 60 s request timeout, which the caller's own request also counts against. */
const CALL_TIMEOUT_MS = 45_000;
/** Per MCP exchange: a `tools/list` page or a tool result, bounded like an `api_call` body. */
const MAX_EXCHANGE_BYTES = 2 * 1024 * 1024;
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * The sanitised upstream descriptors of a connection's catalog, keyed by connection and
 * integration version. Holds no credential and decides no access: every read and call still goes
 * through the proxy.
 */
const catalogCache = createCache<Tool[]>({
  name: "remote-integration-tools",
  ttlMs: CATALOG_TTL_MS,
});

interface RemoteToolsInput {
  scope: SpaceScope;
  actor: Actor;
  reach: ProxyReach;
  integrationId: string;
  caller: ProxyCaller;
  /** The caller's request: its going away ends the exchange. */
  signal?: AbortSignal;
}

/** The latest published manifest, the one `proxyCall` authorizes outside a run against. */
async function remoteManifest(
  integrationId: string,
  orgId: string,
): Promise<{ manifest: IntegrationManifest; url: string }> {
  const loaded = await readIntegrationManifestForProxy(integrationId, orgId, null);
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
  if (isVariableTemplate(source.remote.url)) {
    throw new ApiError({
      status: 422,
      code: "remote_url_templated",
      title: "Server URL Is Templated",
      detail: `Integration '${integrationId}' chooses its server URL per connection; its tools are reached in a run only.`,
    });
  }
  return { manifest: loaded.manifest, url: source.remote.url };
}

/**
 * The upstream tool names the catalog offers: the `"*"` selection (the `tools_policy` keys, or
 * every tool listed when `allow_undeclared_tools` is set), less `hidden_tools`, the connect tool
 * and the `api_call` tools the platform itself serves.
 */
function offeredRemoteToolNames(
  manifest: IntegrationManifest,
  listed: readonly Pick<Tool, "name" | "description">[] | undefined,
): Set<string> {
  const undeclared = (manifest as { allow_undeclared_tools?: boolean }).allow_undeclared_tools;
  const catalog = resolveIntegrationToolCatalog({
    integration: manifest,
    ...(undeclared === true && listed ? { mcpServerTools: listed } : {}),
  });
  const synthetic = new Set(
    getApiCallConfigs(manifest).flatMap((config) =>
      config.uploadToolName ? [config.toolName, config.uploadToolName] : [config.toolName],
    ),
  );
  return new Set(catalog.map((entry) => entry.name).filter((name) => !synthetic.has(name)));
}

async function withClient<T>(
  input: RemoteToolsInput & { connectionId?: string; timeoutMs: number },
  url: string,
  journals: (body: string | null) => boolean,
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
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        reach: input.reach,
        caller: input.caller,
        deadline,
        maxExchangeBytes: MAX_EXCHANGE_BYTES,
        journals,
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

export interface RemoteToolCatalog {
  /** The offered tools, in catalog order. */
  tools: Tool[];
  /**
   * False when the server's `tools/list` could not be read: `tools` then holds the declared names
   * alone, without description or input schema.
   */
  listed: boolean;
}

/**
 * The tools a connection of a remote integration offers, described by the server's `tools/list`
 * (cached per connection and integration version). A server that cannot be listed leaves the
 * declared names; a refusal of the proxy (connection, permission, `authorized_uris`) is thrown.
 */
export async function listRemoteTools(
  input: RemoteToolsInput & { connectionId: string },
): Promise<RemoteToolCatalog> {
  const { manifest, url } = await remoteManifest(input.integrationId, input.scope.orgId);
  const key = `${input.scope.orgId}:${input.connectionId}:${input.integrationId}@${manifest.version}`;
  let described: Tool[] | undefined;
  try {
    described = await catalogCache.get(key, () =>
      withClient(
        { ...input, timeoutMs: LIST_TIMEOUT_MS },
        url,
        () => false,
        async (client, deadline) => {
          const { tools } = await client.listTools({ signal: deadline });
          return tools.flatMap((tool) => sanitiseToolDescriptor(tool) ?? []);
        },
      ),
    );
  } catch (err) {
    // A refusal made before any exchange is the caller's to see; a server fault leaves the names.
    if (err instanceof ApiError || (err instanceof ProxyCallError && !err.connectionId)) {
      throw remoteFailure(err, input.integrationId, url);
    }
    logger.warn("credential-proxy: remote tools/list failed", {
      integrationId: input.integrationId,
      connectionId: input.connectionId,
      error: getErrorMessage(err),
    });
  }
  const offered = offeredRemoteToolNames(manifest, described);
  if (described === undefined) {
    return {
      tools: [...offered].map((name) => ({ name, inputSchema: { type: "object" } })),
      listed: false,
    };
  }
  return { tools: described.filter((tool) => offered.has(tool.name)), listed: true };
}

/**
 * One `tools/call` on a remote integration's server, for a tool its catalog offers; the result's
 * forged runtime events are dropped. A tool outside the catalog is refused before any exchange.
 */
export async function callRemoteTool(
  input: RemoteToolsInput & {
    connectionId?: string;
    name: string;
    arguments: Record<string, unknown>;
  },
): Promise<CallToolResult> {
  const { manifest, url } = await remoteManifest(input.integrationId, input.scope.orgId);
  const undeclared = (manifest as { allow_undeclared_tools?: boolean }).allow_undeclared_tools;
  // With `allow_undeclared_tools`, any listed name is in the selection; the hidden ones never are.
  const offered = offeredRemoteToolNames(
    manifest,
    undeclared === true ? [{ name: input.name }] : undefined,
  );
  if (!offered.has(input.name)) {
    throw notFound(`Integration '${input.integrationId}' offers no tool named '${input.name}'`);
  }
  try {
    const result = await withClient(
      { ...input, timeoutMs: CALL_TIMEOUT_MS },
      url,
      isToolsCall,
      (client, deadline) =>
        client.callTool({ name: input.name, arguments: input.arguments }, { signal: deadline }),
    );
    return stripForgedRuntimeEvents(result);
  } catch (err) {
    throw remoteFailure(err, input.integrationId, url);
  }
}

/**
 * The error a failed exchange answers: the proxy's own refusal as it is, a server fault as a 502
 * naming the server's origin only (its message is untrusted text).
 */
function remoteFailure(err: unknown, integrationId: string, url: string): Error {
  if (err instanceof ApiError) return err;
  if (err instanceof ProxyCallError) return proxyProblem(err.code, err.message);
  const origin = URL.parse(url)?.origin;
  logger.warn("credential-proxy: remote MCP exchange failed", {
    integrationId,
    origin,
    error: getErrorMessage(err),
  });
  const status = httpStatusOf(err);
  if (status === 401 || status === 403) {
    return badGateway(
      `The MCP server at ${origin} refused the connection's credential (HTTP ${status}); reconnect the integration.`,
    );
  }
  return badGateway(`The MCP server at ${origin} did not answer the tool call.`);
}
