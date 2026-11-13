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
import { selectAccessibleConnection, type ProxyReach } from "../integration-connections.ts";
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
  /** Whether an exchange, by its JSON-RPC body, gets a call-journal row. */
  journals: (body: string | null) => boolean;
}

/**
 * Per MCP exchange (a `tools/list` page or a tool result), bounded like an `api_call` body; the
 * proxy's `max_response_bytes` wins when lower.
 */
export const MAX_EXCHANGE_BYTES = 2 * 1024 * 1024;

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
          MAX_EXCHANGE_BYTES,
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
const CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * The sanitised upstream descriptors of a connection's catalog, keyed by connection and
 * integration version. Holds no credential and decides no access: it is read only with a
 * connection the caller's selection resolved.
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
  signal: AbortSignal;
  /**
   * The policy of a caller that asked for connect links (`RUN_CONNECT_OFFERS_HEADER`), `null`
   * otherwise: a selection refusal's items then carry a `connect_url` where a run launch's would
   * (`attachConnectOffers`).
   */
  connectOffers: ConnectOfferPolicy | null;
}

/** The latest published manifest, the one `proxyCall` authorizes outside a run against. */
async function remoteManifest(integrationId: string, orgId: string): Promise<IntegrationManifest> {
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
    throw await withConnectOffers(err, input);
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
function offeredRemoteToolNames(
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

async function withClient<T>(
  input: RemoteToolsInput & { connectionId: string; timeoutMs: number },
  url: string,
  journals: (body: string | null) => boolean,
  use: (client: AppstrateMcpClient, deadline: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const deadline = AbortSignal.any([input.signal, timeout]);
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

/** A tool as the catalog offers it, in the REST wire's casing. */
interface RemoteTool {
  name: string;
  description?: string;
  input_schema: Tool["inputSchema"];
}

export interface RemoteToolCatalog {
  /** The offered tools, in catalog order. */
  tools: RemoteTool[];
  /**
   * False when the server's `tools/list` could not be read: `tools` then holds the declared names
   * alone, without description or input schema.
   */
  listed: boolean;
}

/**
 * The tools the caller's connection of a remote integration offers, described by the server's
 * `tools/list` (cached per connection and integration version). The connection is selected before
 * the cache is read, so a cached catalog answers only a caller who reaches that connection. A
 * server that cannot be listed leaves the declared names; a refusal of the proxy (connection,
 * permission, `authorized_uris`) is thrown.
 */
export async function listRemoteTools(
  input: RemoteToolsInput & { connectionId?: string },
): Promise<RemoteToolCatalog> {
  const manifest = await remoteManifest(input.integrationId, input.scope.orgId);
  const { connectionId, url } = await remoteConnection(input, manifest);
  const key = `${input.scope.orgId}:${connectionId}:${input.integrationId}@${manifest.version}`;
  let described: Tool[] | undefined;
  try {
    described = await catalogCache.get(key, () =>
      withClient(
        { ...input, connectionId, timeoutMs: LIST_TIMEOUT_MS },
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
      connectionId,
      error: getErrorMessage(err),
    });
  }
  const offered = offeredRemoteToolNames(manifest, described);
  if (described === undefined) {
    return {
      tools: [...offered].map((name) => ({ name, input_schema: { type: "object" } })),
      listed: false,
    };
  }
  return {
    tools: described
      .filter((tool) => offered.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
      })),
    listed: true,
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
  const manifest = await remoteManifest(input.integrationId, input.scope.orgId);
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
