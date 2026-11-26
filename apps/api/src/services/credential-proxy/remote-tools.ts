// SPDX-License-Identifier: Apache-2.0

/**
 * The typed tools of a remote MCP integration outside a run: its `tools/list` and one
 * `tools/call` (`mcp-over-proxy.ts`), over the credential proxy with the connection the proxy's
 * selection picks first, or, for an unauthenticated integration (AFPS §7.2), directly, with no
 * connection at all.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createMcpHttpClient,
  isRequestTimeout,
  sanitiseToolDescriptor,
  stripReservedResultMeta,
  toolDefinitionFingerprint,
  type AppstrateMcpClient,
  type ToolDescriptorReduction,
} from "@appstrate/mcp-transport";
import { createCache } from "@appstrate/core/cache";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  allowsUndeclaredTools,
  isUnauthenticatedIntegration,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import type { Actor } from "../../lib/actor.ts";
import type { ConnectOfferPolicy } from "../../lib/connect-offer-policy.ts";
import { findCause } from "@appstrate/core/error-cause";
import { ApiError, conflict, notFound, type ResolutionFieldError } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import { isProxyRefusal, proxyProblem } from "../../lib/proxy-status.ts";
import type { SpaceScope } from "../../lib/scope.ts";
import { attachConnectOffers } from "../connect/preflight-connect-offer.ts";
import {
  assertIntegrationActive,
  selectAccessibleConnection,
  type ProxyReach,
} from "../integration-connections.ts";
import { renderRemoteSource } from "../integration-manifest-helpers.ts";
import { readIntegrationManifestForProxy } from "../integration-service.ts";
import {
  approvedFingerprintsByTool,
  approvedToolNames,
  loadToolSpacePolicy,
  syntheticToolNames,
  type ToolSpacePolicy,
  toolBlockedInSpace,
} from "../integration-tool-catalog.ts";
import { recordToolSnapshot } from "../integration-tool-snapshots.ts";
import { ProxyCallError } from "./core.ts";
import { assertActiveOutsideRun, noConnectionMessage } from "./integration-resolver.ts";
import {
  directMcpOperation,
  isCredentialRejection,
  listToolPages,
  mcpServerFailure,
  proxiedMcpOperation,
  untilAborted,
  untrustedFields,
  untrustedText,
  type ProxyCaller,
} from "./mcp-over-proxy.ts";

/**
 * The deadlines, kept under an MCP client's 60 s request timeout. `call_integration_tool`
 * resolves its tool by name (`resolveMs`, a cold catalog not read by then leaves its declared
 * names), then calls it (`callMs`): 5 + 45 = 50 s, the rest left to the platform's own reads. A
 * search waits up to `listingMs` for every server; each cold `tools/list` runs under its own
 * `listMs` and is cached for the next listing.
 */
const TIMEOUTS = { listMs: 10_000, listingMs: 20_000, resolveMs: 5_000, callMs: 45_000 } as const;
let timeouts: Record<keyof typeof TIMEOUTS, number> = TIMEOUTS;

/** @internal Test-only. Shortens the deadlines; with no argument, restores them. */
export function _setRemoteToolTimeoutsForTesting(next?: Partial<typeof timeouts>): void {
  timeouts = { ...TIMEOUTS, ...next };
}

export function listingDeadline(resolving: boolean): AbortSignal {
  return AbortSignal.timeout(resolving ? timeouts.resolveMs : timeouts.listingMs);
}

const CATALOG_TTL_MS = 5 * 60 * 1000;
/** A sanitised descriptor weighs up to ~10 KiB: 500 could be 5 MiB. Past this, `truncated`. */
const MAX_CATALOG_BYTES = 512 * 1024;
/** Per replica, at most 64 MiB of catalogs; one evicted is listed again on its next use. */
const MAX_CACHED_CATALOGS = 128;

/** A sanitised descriptor and the steps that brought it within the schema budget. */
interface SanitisedTool {
  tool: Tool;
  reduced: ToolDescriptorReduction[];
  /** Of the descriptor as listed, before sanitising: what a space approves. */
  fingerprint: string;
}

interface ReadCatalog {
  tools: SanitisedTool[];
  truncated: boolean;
}

/**
 * Holds no credential and decides no access: read only with a connection the selection chose, or
 * for an unauthenticated integration, whose catalog is the same for every caller.
 */
const catalogCache = createCache<ReadCatalog>({
  name: "remote-integration-tools",
  ttlMs: CATALOG_TTL_MS,
  max: MAX_CACHED_CATALOGS,
});

/**
 * A reconnect may rewrite the variables the URL is rendered from: the URL is in the key. Without
 * a connection (`-`), the catalog is shared by the organization's callers.
 */
function remoteCatalogKey(entry: {
  orgId: string;
  connectionId: string | null;
  integrationId: string;
  version: string;
  url: string;
}): string {
  return `${entry.orgId}:${entry.connectionId ?? "-"}:${entry.integrationId}@${entry.version}:${entry.url}`;
}

/** @internal Test-only: a variable heads a rendered host, which no loopback test server can be. */
export const _remoteCatalogKeyForTesting = remoteCatalogKey;

export interface RemoteToolsCaller {
  scope: SpaceScope;
  actor: Actor;
  reach: ProxyReach;
  caller: ProxyCaller;
  /** The caller's request, or a listing's wait: its end ends a tool call and a wait for a catalog. */
  signal: AbortSignal;
  /** Set when the caller asked for connect links: a selection refusal then carries them. */
  connectOffers: ConnectOfferPolicy | null;
}

type RemoteToolsInput = RemoteToolsCaller & { integrationId: string };

export function streamableRemote(integrationId: string, manifest: IntegrationManifest) {
  const source = manifest.source;
  if (source?.kind !== "remote") {
    throw new ApiError({
      status: 422,
      code: "integration_not_remote",
      title: "Not a Remote Integration",
      detail: `Integration '${integrationId}' is not backed by a remote MCP server.`,
    });
  }
  if (source.remote.transport === "sse") {
    throw new ApiError({
      status: 422,
      code: "sync_transport_unsupported",
      title: "Transport Not Supported",
      detail: `Integration '${integrationId}' uses the SSE transport; only Streamable HTTP servers are supported.`,
    });
  }
  return manifest;
}

/** The published manifest of an active remote integration over Streamable HTTP, for a call outside a run. */
export async function loadStreamableRemote(
  scope: SpaceScope,
  integrationId: string,
): Promise<IntegrationManifest> {
  await assertActiveOutsideRun(scope, integrationId);
  const loaded = await readIntegrationManifestForProxy(integrationId, scope.orgId, null);
  if (!loaded.ok) throw notFound(`Integration '${integrationId}' has no published version`);
  return streamableRemote(integrationId, loaded.manifest);
}

/**
 * The caller's connection, selected as `proxyCall` selects it (for `tool` when given), and the
 * server URL rendered from its variables (AFPS §7.12). An unauthenticated integration binds no
 * connection (`null`): one named is refused before any exchange.
 */
export async function resolveRemoteConnection(
  input: Pick<RemoteToolsInput, "scope" | "actor" | "reach" | "integrationId" | "connectOffers"> & {
    connectionId?: string;
  },
  manifest: IntegrationManifest,
  tool?: string,
): Promise<ResolvedRemote> {
  const unauthenticated = isUnauthenticatedIntegration(manifest);
  const connection = unauthenticated
    ? null
    : await selectAccessibleConnection(input.integrationId, manifest, input.connectionId ?? null, {
        spaceId: input.scope.spaceId,
        actor: input.actor,
        reach: input.reach,
        naming: "connection_id",
        ...(tool !== undefined ? { tool } : {}),
      }).catch(async (err: unknown) => {
        throw await withConnectOffers(err, input);
      });
  if (unauthenticated && input.connectionId)
    throw connectionIdRefusedWithoutAuth(input.integrationId);
  if (!unauthenticated && !connection) {
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
  const remote = renderRemoteSource(manifest, connection?.variables ?? null);
  if (!remote) {
    throw new ApiError({
      status: 422,
      code: "remote_url_unrenderable",
      title: "Server URL Does Not Render",
      detail: `Integration '${input.integrationId}' builds its server URL from the connection's variables, and they do not render it; reconnect with valid values.`,
    });
  }
  return { connectionId: connection?.id ?? null, url: remote.url };
}

/** The connection a call goes through (`null`: an unauthenticated integration) and the server URL. */
type ResolvedRemote = { connectionId: string | null; url: string };

/** A `connection_id` named for an unauthenticated integration, which binds none. */
export function connectionIdRefusedWithoutAuth(integrationId: string): ApiError {
  return proxyProblem(
    "credential_not_found",
    `Integration '${integrationId}' declares no authentication and binds no connection: call it without \`connection_id\`.`,
    "connection_id",
  );
}

async function withConnectOffers(
  err: unknown,
  input: Pick<RemoteToolsInput, "scope" | "actor" | "connectOffers">,
): Promise<unknown> {
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
 * The catalog's `"*"` selection, less the `api_call` tools the platform itself serves, and what the
 * space blocked. On a closed catalog a listed tool the manifest does not declare is offered only
 * at a definition the space approved; `listed` unread, only the declared tools are.
 */
export function offeredRemoteToolNames(
  manifest: IntegrationManifest,
  listed: readonly (Pick<Tool, "name" | "description"> & { fingerprint?: string })[] | undefined,
  policy: ToolSpacePolicy,
): Set<string> {
  const open = allowsUndeclaredTools(manifest);
  const catalog = resolveIntegrationToolCatalog({
    integration: manifest,
    ...(open && listed ? { listedTools: listed } : {}),
  });
  const approved = approvedFingerprintsByTool(policy);
  const approvedListed = open
    ? []
    : (listed ?? []).filter(
        (tool) =>
          tool.fingerprint !== undefined && approved.get(tool.name)?.includes(tool.fingerprint),
      );
  const synthetic = syntheticToolNames(manifest);
  const blocked = new Set(policy.blocks);
  return new Set(
    [...catalog, ...approvedListed]
      .map((entry) => entry.name)
      .filter((name) => !synthetic.has(name) && !blocked.has(name)),
  );
}

/** A failed operation, with the HTTP status of the last exchange its server answered. */
type OperationFailure = (err: unknown, receivedStatus: number | undefined) => unknown;

/** One operation on the server: through `connectionId`, or directly when it is `null`. */
async function withClient<T>(
  input: Omit<RemoteToolsInput, "signal"> & {
    connectionId: string | null;
    timeoutMs: number;
    signal: AbortSignal | null;
  },
  url: string,
  use: (client: AppstrateMcpClient, signal: AbortSignal) => Promise<T>,
  failure: OperationFailure = (err) => err,
): Promise<T> {
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const base = {
    scope: input.scope,
    actor: input.actor,
    integrationId: input.integrationId,
    caller: input.caller,
    deadline: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  };
  const operation =
    input.connectionId === null
      ? directMcpOperation({
          ...base,
          // The activation check `proxyCall` makes on each exchange: switched off since, nothing is sent.
          beforeExchange: () => assertIntegrationActive(input.integrationId, input.scope.spaceId),
        })
      : proxiedMcpOperation({ ...base, connectionId: input.connectionId, reach: input.reach });
  let client: AppstrateMcpClient | undefined;
  try {
    return await operation.guard(
      (async () => {
        client = await createMcpHttpClient(url, {
          fetch: operation.fetch,
          signal: operation.signal,
          onWarning: (message, data) =>
            logger.warn(untrustedText(message), {
              integrationId: input.integrationId,
              ...untrustedFields(data),
            }),
        });
        return use(client, operation.signal);
      })(),
    );
  } catch (err) {
    throw failure(err, operation.receivedStatus());
  } finally {
    // Before the session's close, which is no exchange of the operation.
    operation.settle();
    await client?.close().catch(() => {});
  }
}

function boundedCatalog(tools: SanitisedTool[], truncated: boolean): ReadCatalog {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [index, { tool }] of tools.entries()) {
    bytes += encoder.encode(JSON.stringify(tool)).byteLength;
    if (bytes > MAX_CATALOG_BYTES) return { tools: tools.slice(0, index), truncated: true };
  }
  return { tools, truncated };
}

interface ServerTool {
  name: string;
  description?: string;
  input_schema: Tool["inputSchema"];
  /** Present when the server declares one. */
  output_schema?: NonNullable<Tool["outputSchema"]>;
  /** The schema shown is partial: the budget steps applied, in order. Absent when none was. */
  schema_reduced?: ToolDescriptorReduction[];
}

/**
 * The catalog could not be read to prove what `name` calls, `listing_failure` saying why when
 * known. Retryable: a later listing may read it.
 */
export function catalogUnavailable(
  integrationId: string,
  name: string,
  listingFailure: string | undefined,
): ApiError {
  return new ApiError({
    status: 503,
    code: "tool_catalog_unavailable",
    title: "Tool Catalog Unavailable",
    detail:
      `The catalog of ${integrationId}'s MCP server could not be read` +
      (listingFailure ? ` (${listingFailure})` : "") +
      `, and only it can say which of its tools '${name}' names; nothing was sent. ` +
      `The call may be retried once a listing reads the catalog.`,
    ...(listingFailure ? { extensions: { listing_failure: listingFailure } } : {}),
  });
}

export interface RemoteToolCatalog {
  tools: ServerTool[];
  /** The connection the catalog was read through; `null` for an unauthenticated integration. */
  connectionId: string | null;
  listed: boolean;
  /**
   * Unlisted, why when known: the proxy's problem code, `timeout`, or `not_cached` (a cache-only
   * listing found nothing).
   */
  listingFailure?: string;
  /** How many tools were read when the server lists more; `null` when all were. */
  truncatedAt: number | null;
}

/**
 * The tools the caller's connection offers (an unauthenticated integration's, without one), from
 * the server's cached `tools/list`, read only after the connection is selected. The `tools/list`
 * runs under its own timeout, so a caller whose `signal` ends first leaves it running for the next
 * one; a server that cannot be listed leaves the declared names, and a refusal
 * ({@link isCatalogRefusal}) is thrown.
 */
export async function listRemoteTools(
  input: RemoteToolsInput & {
    manifest: IntegrationManifest;
    connectionId?: string;
    /** Read the cached `tools/list` only; nothing is sent. */
    cachedOnly?: boolean;
    /** List again whatever is cached: the caller asked for the server's catalog as it is now. */
    fresh?: boolean;
    /** The space's policy on this integration when the caller already read it: read once, not again. */
    policy?: ToolSpacePolicy;
    /** The connection the caller already resolved: used as is, not selected again. */
    resolved?: ResolvedRemote;
  },
): Promise<RemoteToolCatalog> {
  const manifest = streamableRemote(input.integrationId, input.manifest);
  const unauthenticated = isUnauthenticatedIntegration(manifest);
  const { connectionId, url } = input.resolved ?? (await resolveRemoteConnection(input, manifest));
  const key = remoteCatalogKey({
    orgId: input.scope.orgId,
    connectionId,
    integrationId: input.integrationId,
    version: manifest.version,
    url,
  });
  if (input.fresh) catalogCache.invalidate(key);
  let snapshotFailure: unknown;
  let described = catalogCache.peek(key);
  let listingFailure: string | undefined =
    described === undefined ? (input.cachedOnly ? "not_cached" : "timeout") : undefined;
  if (described === undefined && !input.signal.aborted && !input.cachedOnly) {
    const load = async () => {
      let listed: { tools: Tool[]; truncated: boolean } | undefined;
      const catalog = await withClient(
        { ...input, connectionId, timeoutMs: timeouts.listMs, signal: null },
        url,
        async (client, signal) => {
          listed = await listToolPages(client, signal);
          return boundedCatalog(
            listed.tools.map((tool) => ({
              ...sanitiseToolDescriptor(tool),
              fingerprint: toolDefinitionFingerprint(tool),
            })),
            listed.truncated,
          );
        },
      );
      // Written once the session is closed, so the snapshot never holds the server's connection
      // open; one that cannot be written must not fail the listing it records.
      if (listed) {
        await recordToolSnapshot({
          orgId: input.scope.orgId,
          packageId: input.integrationId,
          connectionId,
          ...listed,
        }).catch((err: unknown) => {
          logger.warn("credential-proxy: tool snapshot not recorded", {
            integrationId: input.integrationId,
            error: getErrorMessage(err),
          });
          // A refresh exists to write the snapshot: the platform's own failure, not the server's.
          if (input.fresh) {
            snapshotFailure = err;
            throw err;
          }
        });
      }
      return catalog;
    };
    try {
      described = await untilAborted(catalogCache.get(key, load), input.signal);
    } catch (err) {
      if (snapshotFailure !== undefined) {
        throw snapshotFailure;
      } else if (input.signal.aborted && err === input.signal.reason) {
        // The listing runs on for the next one.
      } else if (isCatalogRefusal(err)) {
        throw mcpServerFailure(err, { integrationId: input.integrationId, url, unauthenticated });
      } else {
        listingFailure =
          err instanceof ProxyCallError
            ? err.code
            : isRequestTimeout(err) || findCause(err, (e) => e.name === "TimeoutError")
              ? "timeout"
              : undefined;
        logger.warn("credential-proxy: remote tools/list failed", {
          integrationId: input.integrationId,
          connectionId,
          ...(err instanceof ProxyCallError
            ? { code: err.code }
            : { error: untrustedText(getErrorMessage(err)) }),
        });
      }
    }
  }
  const offered = offeredRemoteToolNames(
    manifest,
    described?.tools.map(({ tool, fingerprint }) => ({ ...tool, fingerprint })),
    input.policy ?? (await loadToolSpacePolicy(input.scope, input.integrationId, manifest)),
  );
  if (described === undefined) {
    return {
      tools: [...offered].map((name) => ({ name, input_schema: { type: "object" } })),
      connectionId,
      listed: false,
      ...(listingFailure ? { listingFailure } : {}),
      truncatedAt: null,
    };
  }
  return {
    tools: described.tools
      .filter(({ tool }) => offered.has(tool.name))
      .map(({ tool, reduced }) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
        ...(tool.outputSchema !== undefined ? { output_schema: tool.outputSchema } : {}),
        ...(reduced.length > 0 ? { schema_reduced: reduced } : {}),
      })),
    connectionId,
    listed: true,
    truncatedAt: described.truncated ? described.tools.length : null,
  };
}

/**
 * Whether a failed catalog read is the caller's to see: a refusal of the proxy or of the egress
 * guard, before any exchange or after one (its own 4xx), or the server refusing the connection's
 * credential (an unauthenticated integration's server asking for one). Any other failure is the
 * server's, and leaves the declared names.
 */
function isCatalogRefusal(err: unknown): boolean {
  if (err instanceof ApiError) return true;
  if (err instanceof ProxyCallError) return !err.sent || isProxyRefusal(err.code);
  return isCredentialRejection(err);
}

/**
 * One `tools/call`, its result without reserved `_meta` keys. Activation is checked first; a tool
 * outside the catalog, or a connection not serving it (any connection, for an unauthenticated
 * integration), is refused before any exchange.
 */
export async function callRemoteTool(
  input: RemoteToolsInput & {
    connectionId?: string;
    name: string;
    arguments: Record<string, unknown>;
  },
): Promise<CallToolResult> {
  const manifest = await loadStreamableRemote(input.scope, input.integrationId);
  const policy = await loadToolSpacePolicy(input.scope, input.integrationId, manifest);
  if (policy.blocks.includes(input.name)) {
    throw toolBlockedInSpace(input.integrationId, input.name);
  }
  const open = allowsUndeclaredTools(manifest);
  const offered = offeredRemoteToolNames(
    manifest,
    open ? [{ name: input.name }] : undefined,
    policy,
  );
  // On a closed catalog, an undeclared tool the space approved is judged on the listing below
  // (an open catalog has no approvals: the policy is judged).
  const approvedUndeclared = !offered.has(input.name) && approvedToolNames(policy).has(input.name);
  if (!offered.has(input.name) && !approvedUndeclared) {
    throw notFound(`Integration '${input.integrationId}' offers no tool named '${input.name}'`);
  }
  const resolved = await resolveRemoteConnection(input, manifest, input.name);
  const { connectionId, url } = resolved;
  if (approvedUndeclared) {
    // The listing offers it only at a definition the space approved.
    const catalog = await listRemoteTools({ ...input, manifest, policy, resolved });
    if (!catalog.listed) {
      throw catalogUnavailable(input.integrationId, input.name, catalog.listingFailure);
    }
    if (!catalog.tools.some((tool) => tool.name === input.name)) {
      throw conflict(
        "tool_definition_not_approved",
        `The definition of tool '${input.name}' on integration '${input.integrationId}' is not one this space approved; review it in the integration's settings.`,
      );
    }
  }
  // Set once the session is open: a failure after it is the `tools/call` exchange's. No tool
  // definition was listed on this client, so the SDK validates no output and raises no -32602
  // of its own after the call: one caught here is the server's.
  let calling = false;
  const result = await withClient(
    { ...input, connectionId, timeoutMs: timeouts.callMs },
    url,
    (client, signal) => {
      calling = true;
      return client.callTool({ name: input.name, arguments: input.arguments }, { signal });
    },
    (err, receivedStatus) =>
      mcpServerFailure(err, {
        integrationId: input.integrationId,
        url,
        unauthenticated: connectionId === null,
        failed: "did not answer the tool call",
        tooLarge: "the tool ran, but its result is too large to relay; ask it for less",
        toolCall: calling,
        ...(receivedStatus !== undefined ? { receivedStatus } : {}),
      }),
  );
  return stripReservedResultMeta(result);
}
