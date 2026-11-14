// SPDX-License-Identifier: Apache-2.0

/**
 * The typed tools of an integration backed by a remote MCP server (`source.kind: "remote"`),
 * outside a run: its `tools/list` and one `tools/call`, spoken over the credential proxy
 * (`mcp-over-proxy.ts`). The connection is selected first, by the proxy's rule
 * (`selectAccessibleConnection`), and every catalog read, URL rendering and exchange uses it. The
 * tools offered are the integration catalog's (`"*"` selection less `hidden_tools` and the connect
 * tool), sanitised as `McpHost` registers them in a run.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHttpClient,
  sanitiseToolDescriptor,
  stripReservedResultMeta,
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
import { ApiError, notFound, type ResolutionFieldError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { proxyProblem } from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { attachConnectOffers } from "../connect/preflight-connect-offer.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  type ProxyReach,
} from "../integration-connections.ts";
import { renderRemoteSource } from "../integration-manifest-helpers.ts";
import { readIntegrationManifestForProxy } from "../integration-service.ts";
import { ProxyCallError } from "./core.ts";
import { noConnectionMessage } from "./integration-resolver.ts";
import {
  listToolPages,
  mcpServerFailure,
  proxiedMcpOperation,
  type ProxyCaller,
} from "./mcp-over-proxy.ts";

/**
 * Listing a catalog takes a few round trips, each answered within seconds by a healthy server; a
 * call stays below an MCP client's 60 s request timeout, which the caller's request also counts.
 */
const timeouts = { listMs: 10_000, callMs: 45_000 };

/** Shortens the operations' deadlines; with no argument, restores them. */
export function _setRemoteToolTimeoutsForTesting(next?: Partial<typeof timeouts>): void {
  Object.assign(timeouts, { listMs: 10_000, callMs: 45_000 }, next);
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
/** A sanitised descriptor weighs up to ~10 KiB: 500 could be 5 MiB. Past this, `truncated`. */
const MAX_CATALOG_BYTES = 512 * 1024;
/** Per replica, at most 64 MiB of catalogs; one evicted is listed again on its next use. */
const MAX_CACHED_CATALOGS = 128;

/** Holds no credential and decides no access: read only with a connection the selection chose. */
const catalogCache = createCache<{ tools: Tool[]; truncated: boolean }>({
  name: "remote-integration-tools",
  ttlMs: CATALOG_TTL_MS,
  max: MAX_CACHED_CATALOGS,
});

/**
 * A catalog's cache key. The URL is in it because a reconnect may rewrite the variables it is
 * rendered from: a connection whose variables were cleared takes them anew on its next reconnect.
 */
export function remoteCatalogKey(entry: {
  orgId: string;
  connectionId: string;
  integrationId: string;
  version: string;
  url: string;
}): string {
  return `${entry.orgId}:${entry.connectionId}:${entry.integrationId}@${entry.version}:${entry.url}`;
}

/** Who lists or calls a remote integration's tools outside a run, and how. */
export interface RemoteToolsCaller {
  scope: SpaceScope;
  actor: Actor;
  reach: ProxyReach;
  caller: ProxyCaller;
  /** The caller's request: its going away ends a tool call and its wait for a listing. */
  signal: AbortSignal;
  /**
   * The policy of a caller that asked for connect links (`RUN_CONNECT_OFFERS_HEADER`), `null`
   * otherwise: a selection refusal's items then carry a `connect_url` where a run launch's would
   * (`attachConnectOffers`).
   */
  connectOffers: ConnectOfferPolicy | null;
}

type RemoteToolsInput = RemoteToolsCaller & { integrationId: string };

/** `manifest`, when its server speaks Streamable HTTP; else `422 integration_not_remote`. */
function streamableRemote(integrationId: string, manifest: IntegrationManifest) {
  const source = manifest.source;
  if (source?.kind !== "remote" || source.remote.transport === "sse") {
    throw new ApiError({
      status: 422,
      code: "integration_not_remote",
      title: "Not a Remote Integration",
      detail: `Integration '${integrationId}' is not backed by a Streamable HTTP MCP server.`,
    });
  }
  return manifest;
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
      naming: "connection_id",
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
        reach: input.reach,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        connectionNaming: "connection_id",
      }),
      input.connectionId ? "connection_id" : undefined,
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

/** A selection refusal with the `connect_url` of each item a connect flow clears (`attachConnectOffers`). */
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

/** One MCP operation over the proxy, bounded by `timeoutMs` and `signal` if given. */
async function withClient<T>(
  input: Omit<RemoteToolsInput, "signal"> & {
    connectionId: string;
    timeoutMs: number;
    signal: AbortSignal | null;
  },
  url: string,
  use: (client: AppstrateMcpClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const operation = proxiedMcpOperation({
    scope: input.scope,
    actor: input.actor,
    integrationId: input.integrationId,
    connectionId: input.connectionId,
    reach: input.reach,
    caller: input.caller,
    deadline: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  let client: AppstrateMcpClient | undefined;
  try {
    return await operation.guard(
      (async () => {
        client = await createMcpHttpClient(url, {
          fetch: operation.fetch,
          signal: operation.signal,
          onWarning: (message, data) =>
            logger.warn(message, { integrationId: input.integrationId, ...data }),
        });
        return use(client, operation.signal);
      })(),
    );
  } finally {
    // Before the session's close, which is no exchange of the operation.
    await operation.settle();
    await client?.close().catch(() => {});
  }
}

/** The descriptors kept within {@link MAX_CATALOG_BYTES}, in the server's order. */
function boundedCatalog(tools: Tool[], truncated: boolean): { tools: Tool[]; truncated: boolean } {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [index, tool] of tools.entries()) {
    bytes += encoder.encode(JSON.stringify(tool)).byteLength;
    if (bytes > MAX_CATALOG_BYTES) return { tools: tools.slice(0, index), truncated: true };
  }
  return { tools, truncated };
}

/** A tool as the catalog offers it, in the REST wire's casing. */
interface RemoteTool {
  name: string;
  description?: string;
  input_schema: Tool["inputSchema"];
  /** Present when the server declares one. */
  output_schema?: NonNullable<Tool["outputSchema"]>;
}

export interface RemoteToolCatalog {
  /** The offered tools: in the server's order when listed, else the declared names. */
  tools: RemoteTool[];
  /** False when the server could not be listed: `tools` are the declared names alone. */
  listed: boolean;
  /** The server lists more tools than are read: only the first ones are offered. */
  truncated: boolean;
}

/**
 * The tools the caller's connection of a remote integration offers, described by the server's
 * `tools/list` (cached per connection, integration version and server URL), for an integration
 * whose activation the listing checked and whose published `manifest` it read. The connection is
 * selected before the cache is read, so a cached catalog answers only a caller who reaches that
 * connection.
 *
 * The listing runs under its own timeout alone: callers sharing it never depend on the first one
 * staying, and a caller whose wait (`waitUntil`, or its own request) ends first leaves it running
 * for the next. Once that wait is over, no listing is started: a cached catalog answers, else the
 * declared names. A server that cannot be listed leaves the declared names; a refusal of the proxy
 * (connection, permission, `authorized_uris`) or of the server (the connection's credential) is
 * thrown.
 */
export async function listRemoteTools(
  input: RemoteToolsInput & {
    manifest: IntegrationManifest;
    connectionId?: string;
    waitUntil: AbortSignal;
  },
): Promise<RemoteToolCatalog> {
  const manifest = streamableRemote(input.integrationId, input.manifest);
  const { connectionId, url } = await remoteConnection(input, manifest);
  const key = remoteCatalogKey({
    orgId: input.scope.orgId,
    connectionId,
    integrationId: input.integrationId,
    version: manifest.version,
    url,
  });
  const wait = AbortSignal.any([input.waitUntil, input.signal]);
  let described = catalogCache.peek(key);
  if (described === undefined && !wait.aborted) {
    const load = () =>
      withClient(
        { ...input, connectionId, timeoutMs: timeouts.listMs, signal: null },
        url,
        async (client, signal) => {
          const { tools, truncated } = await listToolPages(client, signal);
          return boundedCatalog(
            tools.flatMap((tool) => sanitiseToolDescriptor(tool) ?? []),
            truncated,
          );
        },
      );
    try {
      described = await beforeDeadline(catalogCache.get(key, load), wait);
    } catch (err) {
      const failure = mcpServerFailure(err, { integrationId: input.integrationId, url });
      // A refusal made before any exchange, or the server refusing the credential, is the
      // caller's to see; any other fault leaves the declared names.
      if (
        err instanceof ApiError ||
        (err instanceof ProxyCallError && !err.connectionId) ||
        (failure instanceof ApiError && failure.code === "upstream_credential_rejected")
      ) {
        throw failure;
      }
      logger.warn("credential-proxy: remote tools/list failed", {
        integrationId: input.integrationId,
        connectionId,
        error: getErrorMessage(err),
      });
    }
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
        ...(tool.outputSchema !== undefined ? { output_schema: tool.outputSchema } : {}),
      })),
    listed: true,
    truncated: described.truncated,
  };
}

/** A listing no longer waited for: its catalog is read for a later one. */
class ListingDeadlineError extends Error {
  constructor() {
    super("the listing's deadline passed before the server's catalog was read");
    this.name = "ListingDeadlineError";
  }
}

/** `work`'s outcome, or a {@link ListingDeadlineError} once `deadline` ends first. */
function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal): Promise<T> {
  // Its outcome after the deadline belongs to the cache alone.
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const expire = () => reject(new ListingDeadlineError());
    if (deadline.aborted) return expire();
    deadline.addEventListener("abort", expire, { once: true });
    work.then(resolve, reject).finally(() => deadline.removeEventListener("abort", expire));
  });
}

/**
 * One `tools/call` on a remote integration's server, for a tool its catalog offers; the result's
 * reserved `_meta` keys are dropped. Entered directly by its route: the integration's activation
 * is checked before anything else, and a tool outside the catalog, or a connection that does not
 * serve the tool (its auth, its scopes), is refused before any exchange.
 */
export async function callRemoteTool(
  input: RemoteToolsInput & {
    connectionId?: string;
    name: string;
    arguments: Record<string, unknown>;
  },
): Promise<CallToolResult> {
  await assertIntegrationActive(input.integrationId, input.scope.spaceId);
  const loaded = await readIntegrationManifestForProxy(
    input.integrationId,
    input.scope.orgId,
    null,
  );
  if (!loaded.ok) throw notFound(`Integration '${input.integrationId}' has no published version`);
  const manifest = streamableRemote(input.integrationId, loaded.manifest);
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
      { ...input, connectionId, timeoutMs: timeouts.callMs },
      url,
      (client, signal) =>
        client.callTool({ name: input.name, arguments: input.arguments }, { signal }),
    );
    return stripReservedResultMeta(result);
  } catch (err) {
    throw mcpServerFailure(err, {
      integrationId: input.integrationId,
      url,
      failed: "did not answer the tool call",
      tooLarge: "the tool ran, but its result is too large to relay; ask it for less",
    });
  }
}
