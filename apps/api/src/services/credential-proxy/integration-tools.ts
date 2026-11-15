// SPDX-License-Identifier: Apache-2.0

/**
 * The tools a caller may call outside a run in a space, named as they are called: each
 * integration's `api_call` tools (`{ns}__api_call`, `{ns}__api_call__{auth}` when several of its
 * auths expose one), reached through `/api/credential-proxy/proxy`, and the typed tools of a
 * remote MCP server (`{ns}__{tool}`), read by `listRemoteTools` and reached through
 * `callRemoteTool`. The connections the tools reach are listed once; each tool names its own
 * among them, a typed tool with the scopes its `tools_policy` entry requires that one lacks.
 *
 * Tool names are unique in a space ({@link integrationNamespaces}): a name resolves to one tool of
 * one integration, whatever connections the caller holds.
 */

import {
  allowsUndeclaredTools,
  getApiCallConfigs,
  missingScopesForConnection,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { allocateMcpToolName, normaliseMcpToolNamespace } from "@appstrate/core/naming";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import type { ProblemDetail } from "@appstrate/core/api-errors";
import { ApiError, notFound } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
import type { ProxyConnectionStatus } from "../integration-connections.ts";
import {
  activeIntegrationIds,
  connectionsOutsideRun,
  integrationsOutsideRun,
  publishedManifests,
  type ConnectionOutsideRun,
  type IntegrationOutsideRun,
} from "./integration-resolver.ts";
import {
  listingDeadline,
  listRemoteTools,
  offeredRemoteToolNames,
  type RemoteToolCatalog,
  type RemoteToolsCaller,
} from "./remote-tools.ts";

interface ToolBase {
  name: string;
  integration_package_id: string;
  description: string;
  /** The listing's `connections` it reaches. */
  connection_ids: string[];
}

interface ApiCallTool extends ToolBase {
  kind: "api_call";
  auth_key: string;
  /** The integration also has connections of another auth: a call names one of them. */
  connection_required: boolean;
}

interface RemoteTool extends ToolBase {
  kind: "remote";
  /** The name the server lists it by: `tools/call` takes it. */
  remote_name: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  /** The server could not be listed: the tool is declared, without description or schema. */
  catalog_unreadable?: true;
  /** Per connection lacking some, the scopes its `tools_policy` entry requires. */
  missing_scopes?: Record<string, string[]>;
}

export type IntegrationTool = ApiCallTool | RemoteTool;

interface UnlistedIntegration {
  integration_package_id: string;
  refusal: ProblemDetail;
}

interface TruncatedCatalog {
  integration_package_id: string;
  listed_tools: number;
}

export interface IntegrationToolListing {
  tools: IntegrationTool[];
  connections: ConnectionOutsideRun[];
  /** The integrations active here that the caller has no usable connection of. */
  not_ready: IntegrationOutsideRun[];
  unlisted: UnlistedIntegration[];
  truncated_catalogs: TruncatedCatalog[];
}

interface IntegrationToolQuery {
  integrationId?: string;
  /**
   * Resolves the tool of this name alone, under the shorter resolution deadline: an `api_call`
   * tool reads no server, and only the remote integration whose namespace starts the name is
   * listed. `not_ready` is then left empty.
   */
  name?: string;
  connectionId?: string;
}

/**
 * The `proxy_connection` statuses of an integration without a usable connection: a call naming
 * none is refused, and no connection a call could name instead clears it. `proxy_closed` is none
 * of a listing's: `reachOutsideRun` refuses a closed space before it.
 */
const NOT_READY_STATUSES: ReadonlySet<ProxyConnectionStatus> = new Set([
  "none",
  "needs_reconnection",
  "not_permitted",
  "default_unavailable",
  "unusable",
]);

const LIST_CONCURRENCY = 3;
/** Hex digits of the package id's hash a clashing namespace takes first; 16 at most. */
const NAMESPACE_HASH_LENGTH = 6;
const MAX_NAMESPACE_HASH_LENGTH = 16;

/**
 * The namespace of each integration active in a space: its normalised id, without the trailing
 * `_` the length cut may leave, followed by `_` and a hash of its id while it equals another's.
 * No namespace holds `__` or ends with `_`, so distinct namespaces never yield the same
 * `{ns}__{body}` name, and the result depends on the set of ids alone.
 */
export function integrationNamespaces(ids: readonly string[]): Map<string, string> {
  const bases = new Map(
    ids.map((id) => {
      let base = normaliseMcpToolNamespace(id);
      while (base.endsWith("_")) base = base.slice(0, -1);
      return [id, base];
    }),
  );
  const hashLength = new Map<string, number>(
    ids.map((id) => [id, bases.get(id) ? 0 : NAMESPACE_HASH_LENGTH]),
  );
  const namespaceOf = (id: string) => {
    const base = bases.get(id)!;
    const length = hashLength.get(id)!;
    if (length === 0) return base;
    const hash = fnv1a64Hex(id).slice(0, length);
    return base ? `${base}_${hash}` : hash;
  };
  for (;;) {
    const holders = new Map<string, string[]>();
    for (const id of ids) {
      const namespace = namespaceOf(id);
      holders.set(namespace, [...(holders.get(namespace) ?? []), id]);
    }
    const clashing = [...holders.values()].filter((group) => group.length > 1).flat();
    const growable = clashing.filter((id) => hashLength.get(id)! < MAX_NAMESPACE_HASH_LENGTH);
    if (growable.length === 0) break;
    for (const id of growable) {
      const length = hashLength.get(id)!;
      hashLength.set(id, length === 0 ? NAMESPACE_HASH_LENGTH : length + 2);
    }
  }
  return new Map(ids.map((id) => [id, namespaceOf(id)]));
}

/** Every `api_call` tool name of the catalog, connected or not: a typed tool never takes one. */
function apiCallToolNames(namespace: string, manifest: IntegrationManifest): Set<string> {
  const catalog = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((entry) => entry.name),
  );
  return new Set(
    getApiCallConfigs(manifest)
      .filter((config) => catalog.has(config.toolName))
      .map((config) => `${namespace}__${config.toolName}`),
  );
}

interface ListedIntegration {
  id: string;
  namespace: string;
  manifest: IntegrationManifest;
  connections: readonly ConnectionOutsideRun[];
  apiCallNames: ReadonlySet<string>;
}

function apiCallTools(entry: ListedIntegration): ApiCallTool[] {
  const { id, namespace, manifest, connections } = entry;
  const configs = getApiCallConfigs(manifest);
  const about = `${manifest.display_name ?? manifest.name}.${
    typeof manifest.description === "string" ? ` ${manifest.description}` : ""
  }`;
  return configs.flatMap((config): ApiCallTool[] => {
    const name = `${namespace}__${config.toolName}`;
    const reached = connections.filter((c) => c.auth_key === config.authKey);
    if (!entry.apiCallNames.has(name) || reached.length === 0) return [];
    return [
      {
        kind: "api_call",
        name,
        integration_package_id: id,
        description: configs.length > 1 ? `${about} Uses its \`${config.authKey}\` auth.` : about,
        auth_key: config.authKey,
        connection_required: reached.length < connections.length,
        connection_ids: reached.map((c) => c.connection_id),
      },
    ];
  });
}

/**
 * The server's catalog, listed with the connection named when it is one of `connections`, else
 * with the proxy's selection. When that selection asks for a choice, the first of the caller's
 * own connections the proxy accepts serves: a connection another member shared serves only when
 * named or designated by an organization default, as for a call.
 */
async function readRemoteCatalog(
  caller: RemoteToolsCaller,
  entry: ListedIntegration,
  connectionId: string | undefined,
): Promise<RemoteToolCatalog> {
  const named = entry.connections.find(
    (c) => c.connection_id.toLowerCase() === connectionId?.toLowerCase(),
  );
  const list = (id: string | undefined) =>
    listRemoteTools({
      ...caller,
      integrationId: entry.id,
      manifest: entry.manifest,
      ...(id ? { connectionId: id } : {}),
    });
  try {
    return await list(named?.connection_id);
  } catch (err) {
    if (named || !(err instanceof ApiError) || err.code !== "must_choose_connection") throw err;
    for (const connection of entry.connections.filter((c) => c.owned_by_actor)) {
      try {
        return await list(connection.connection_id);
      } catch {
        // The next connection may serve.
      }
    }
    throw err;
  }
}

type RemoteListing =
  { tools: RemoteTool[]; truncatedAt: number | null } | { unlisted: UnlistedIntegration };

/**
 * Whether `name` may be one of a remote integration's tools, its server unread: any name of its
 * namespace when it allows undeclared tools, else one of its declared tools' names.
 */
function mayNameRemoteTool(entry: ListedIntegration, name: string): boolean {
  if (!name.startsWith(`${entry.namespace}__`)) return false;
  if (allowsUndeclaredTools(entry.manifest)) return true;
  return [...offeredRemoteToolNames(entry.manifest, undefined)].some((declared) => {
    const taken = new Set(entry.apiCallNames);
    const plain = allocateMcpToolName(entry.namespace, declared, (n) => taken.has(n));
    taken.add(plain);
    return (
      name === plain || name === allocateMcpToolName(entry.namespace, declared, (n) => taken.has(n))
    );
  });
}

/**
 * The typed tools of a remote integration, or the proxy's refusal to list it, kept with `name`
 * only when that name may be one of its tools.
 */
async function remoteTools(
  caller: RemoteToolsCaller,
  entry: ListedIntegration,
  query: Pick<IntegrationToolQuery, "name" | "connectionId">,
): Promise<RemoteListing> {
  const { id: integrationId, namespace, manifest, connections } = entry;
  let catalog: RemoteToolCatalog;
  try {
    catalog = await readRemoteCatalog(caller, entry, query.connectionId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (query.name !== undefined && !mayNameRemoteTool(entry, query.name)) {
      return { tools: [], truncatedAt: null };
    }
    return {
      unlisted: {
        integration_package_id: integrationId,
        refusal: err.toProblemDetail(caller.caller.requestId),
      },
    };
  }
  const about = manifest.display_name ?? manifest.name;
  const remoteTool = (
    name: string,
    upstream: RemoteToolCatalog["tools"][number],
    unreadable: boolean,
  ): RemoteTool => {
    const missing = Object.fromEntries(
      connections.flatMap((connection) => {
        const scopes = missingScopesForConnection({
          manifest,
          authKey: connection.auth_key,
          granted: connection.scopes_granted,
          agentTools: [upstream.name],
          agentScopes: [],
        });
        return scopes.length > 0 ? [[connection.connection_id, scopes]] : [];
      }),
    );
    return {
      kind: "remote",
      name,
      integration_package_id: integrationId,
      description: upstream.description ? `${about}. ${upstream.description}` : `${about}.`,
      remote_name: upstream.name,
      input_schema: upstream.input_schema,
      ...(upstream.output_schema ? { output_schema: upstream.output_schema } : {}),
      ...(unreadable ? { catalog_unreadable: true as const } : {}),
      connection_ids: connections.map((c) => c.connection_id),
      ...(Object.keys(missing).length > 0 ? { missing_scopes: missing } : {}),
    };
  };
  const taken = new Set(entry.apiCallNames);
  const tools = catalog.tools.flatMap((upstream): RemoteTool[] => {
    let name: string;
    try {
      name = allocateMcpToolName(namespace, upstream.name, (n) => taken.has(n));
    } catch {
      // An unresolvable collision costs that one tool, as in a run (`McpHost`).
      logger.warn("credential-proxy: MCP tool name collides after re-hashing, tool dropped", {
        integrationId,
        namespace,
        originalName: upstream.name.slice(0, 128),
      });
      return [];
    }
    taken.add(name);
    return [remoteTool(name, upstream, !catalog.listed)];
  });
  const named = query.name;
  if (
    named !== undefined &&
    !catalog.listed &&
    allowsUndeclaredTools(manifest) &&
    named.startsWith(`${namespace}__`) &&
    !taken.has(named)
  ) {
    // Its server unread, an undeclared tool is called by the name it was given.
    const remoteName = named.slice(namespace.length + 2);
    tools.push(remoteTool(named, { name: remoteName, input_schema: { type: "object" } }, true));
  }
  return { tools, truncatedAt: catalog.truncatedAt };
}

/**
 * Every tool the caller may call outside a run in the space, sorted by integration, `api_call`
 * tools first, with the connections they reach, the integrations without a usable connection and
 * the remote ones the proxy refused to list. Read under `reach`, activation checked before any
 * connection is selected; servers are waited for until {@link listingDeadline}.
 */
export async function listIntegrationTools(
  caller: RemoteToolsCaller,
  query: IntegrationToolQuery,
): Promise<IntegrationToolListing> {
  const { scope, actor, reach, connectOffers } = caller;
  const activeIds = await activeIntegrationIds(scope);
  if (query.integrationId !== undefined && !activeIds.includes(query.integrationId)) {
    throw notFound(`Integration '${query.integrationId}' is not active in this space`);
  }
  const manifests = await publishedManifests(
    scope.orgId,
    query.integrationId !== undefined ? [query.integrationId] : activeIds,
  );
  const [reachable, notReady] = await Promise.all([
    connectionsOutsideRun(scope, actor, reach, manifests),
    query.name === undefined
      ? integrationsOutsideRun(scope, actor, reach, connectOffers, manifests)
      : [],
  ]);

  const byIntegration = new Map<string, ConnectionOutsideRun[]>();
  for (const connection of reachable) {
    const id = connection.integration_package_id;
    byIntegration.set(id, [...(byIntegration.get(id) ?? []), connection]);
  }
  const namespaces = integrationNamespaces(activeIds);
  const integrations = [...byIntegration]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, connections]): ListedIntegration => {
      const namespace = namespaces.get(id)!;
      const manifest = manifests.get(id)!;
      return {
        id,
        namespace,
        manifest,
        connections,
        apiCallNames: apiCallToolNames(namespace, manifest),
      };
    });

  const httpTools = new Map(integrations.map((entry) => [entry.id, apiCallTools(entry)]));
  const named = (tools: IntegrationTool[]) =>
    query.name === undefined ? tools : tools.filter((tool) => tool.name === query.name);
  const connectionsOf = (tools: IntegrationTool[]) => {
    const ids = new Set(tools.map((tool) => tool.integration_package_id));
    return reachable.filter((c) => ids.has(c.integration_package_id));
  };
  const httpMatch = named([...httpTools.values()].flat());
  if (query.name !== undefined && httpMatch.length > 0) {
    return {
      tools: httpMatch,
      connections: connectionsOf(httpMatch),
      not_ready: [],
      unlisted: [],
      truncated_catalogs: [],
    };
  }

  const remote = integrations.filter(
    (entry) =>
      entry.manifest.source?.kind === "remote" &&
      (query.name === undefined || query.name.startsWith(`${entry.namespace}__`)),
  );
  const listing = {
    ...caller,
    signal: AbortSignal.any([caller.signal, listingDeadline(query.name !== undefined)]),
  };
  const listed = new Map(
    await mapWithConcurrency(
      remote,
      LIST_CONCURRENCY,
      async (entry) => [entry.id, await remoteTools(listing, entry, query)] as const,
    ),
  );

  const tools: IntegrationTool[] = [];
  const unlisted: UnlistedIntegration[] = [];
  const truncatedCatalogs: TruncatedCatalog[] = [];
  for (const { id } of integrations) {
    tools.push(...httpTools.get(id)!);
    const result = listed.get(id);
    if (result === undefined) continue;
    if ("unlisted" in result) {
      unlisted.push(result.unlisted);
      continue;
    }
    tools.push(...result.tools);
    if (result.truncatedAt !== null) {
      truncatedCatalogs.push({ integration_package_id: id, listed_tools: result.truncatedAt });
    }
  }
  const shown = named(tools);
  return {
    tools: shown,
    connections: connectionsOf(shown),
    not_ready: notReady.filter((entry) => NOT_READY_STATUSES.has(entry.proxy_connection.status)),
    unlisted,
    truncated_catalogs: query.name === undefined ? truncatedCatalogs : [],
  };
}
