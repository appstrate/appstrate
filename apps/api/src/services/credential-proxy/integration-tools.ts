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
 * one integration, whatever connections the caller holds. Within an integration, a typed tool's
 * name is a function of its upstream name alone ({@link remoteToolName}).
 */

import {
  allowsUndeclaredTools,
  getApiCallConfigs,
  missingScopesForConnection,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { normaliseMcpToolNamespace } from "@appstrate/core/naming";
import { API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME } from "@appstrate/afps-shared/api-tool-naming";
import {
  fnv1a64Hex,
  isValidMcpToolName,
  MCP_TOOL_NAME_MAX_LENGTH,
  normaliseMcpToolBody,
} from "@appstrate/afps-shared/mcp-naming";
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

/** Hex digits of the upstream name's hash a transformed tool name ends with. */
const TOOL_NAME_HASH_LENGTH = 8;

/**
 * The bodies the platform's own tools of an integration take: `api_call`, `api_upload` and their
 * per-auth `__{auth}` forms. No typed tool's name has one.
 */
function isReservedBody(body: string): boolean {
  return [API_CALL_TOOL_NAME, API_UPLOAD_TOOL_NAME].some(
    (name) => body === name || body.startsWith(`${name}__`),
  );
}

/**
 * `{namespace}__{prefix}{head}_{hash}` within {@link MCP_TOOL_NAME_MAX_LENGTH}: `head` cut to
 * what is left and stripped of leading and trailing `_`, dropped (with its `_`) when nothing is
 * left, the hash of `seed` shortened only when the prefix leaves it less room.
 */
function hashedToolName(namespace: string, prefix: string, head: string, seed: string): string {
  const room = MCP_TOOL_NAME_MAX_LENGTH - namespace.length - 2 - prefix.length;
  const hash = fnv1a64Hex(seed).slice(0, Math.min(TOOL_NAME_HASH_LENGTH, room));
  const kept = head.slice(0, Math.max(0, room - hash.length - 1)).replace(/^_+|_+$/g, "");
  return `${namespace}__${prefix}${kept ? `${kept}_` : ""}${hash}`;
}

/** A body shaped like a hashed one: ending in `_` and a hash, or a hash alone. */
const HASHED_BODY = new RegExp(`(?:^|_)[0-9a-f]{${TOOL_NAME_HASH_LENGTH}}$`);

/**
 * The name a typed tool of the integration of `namespace` is exposed by, a function of its
 * upstream name alone: `{namespace}__{upstream}` when that is a valid tool name, the upstream
 * name is no reserved body ({@link isReservedBody}) and is not shaped like a hashed body
 * ({@link HASHED_BODY}); otherwise the hashed form: the upstream name mapped onto the body
 * alphabet, its `_` runs collapsed, cut to fit, stripped of leading and trailing `_`, and
 * followed by `_` and a hash of the upstream name. A hashed body holds no `__`, so it never is
 * nor starts with a reserved form, and no plain name can equal a hashed one.
 */
export function remoteToolName(namespace: string, upstreamName: string): string {
  const plain = `${namespace}__${upstreamName}`;
  if (!isReservedBody(upstreamName) && !HASHED_BODY.test(upstreamName) && isValidMcpToolName(plain))
    return plain;
  const head = normaliseMcpToolBody(upstreamName).replace(/_+/g, "_");
  return hashedToolName(namespace, "", head, upstreamName);
}

/**
 * The upstream name `name` calls without a catalog to prove it: its body, when `name` is that
 * body's own plain exposed name. A hashed name, or one shaped like it, needs the catalog.
 */
function selfNamedUpstream(namespace: string, name: string): string | undefined {
  if (!name.startsWith(`${namespace}__`)) return undefined;
  const body = name.slice(namespace.length + 2);
  return remoteToolName(namespace, body) === name && !HASHED_BODY.test(body) ? body : undefined;
}

/**
 * Each exposed name of `upstreamNames`, mapped to the one upstream name it calls. Only hashed
 * names can be exposed alike (a hash collision): every holder of one is dropped and logged, as
 * `McpHost` logs a collision in a run, so what a name calls never depends on the set read.
 */
function exposeRemoteTools(
  integrationId: string,
  namespace: string,
  upstreamNames: Iterable<string>,
): Map<string, string> {
  const holders = new Map<string, string[]>();
  for (const upstream of new Set(upstreamNames)) {
    const name = remoteToolName(namespace, upstream);
    holders.set(name, [...(holders.get(name) ?? []), upstream]);
  }
  const exposed = new Map<string, string>();
  for (const [name, group] of holders) {
    if (group.length === 1) {
      exposed.set(name, group[0]!);
      continue;
    }
    for (const dropped of group) {
      logger.warn("credential-proxy: MCP tool name collides, tool dropped", {
        integrationId,
        name,
        originalName: dropped.slice(0, 128),
      });
    }
  }
  return exposed;
}

/**
 * The exposed name of an `api_call` tool (`api_call`, `api_call__{auth}`): `{namespace}__{tool}`
 * when valid, else the auth part cut to fit behind `api_call__` and a hash of the tool name.
 */
function apiCallToolName(namespace: string, toolName: string): string {
  const plain = `${namespace}__${toolName}`;
  if (isValidMcpToolName(plain)) return plain;
  const prefix = `${API_CALL_TOOL_NAME}__`;
  const auth = normaliseMcpToolBody(toolName.slice(prefix.length));
  return hashedToolName(namespace, prefix, auth, toolName);
}

/**
 * Every `api_call` tool of the catalog, connected or not, by exposed name: a name two auths would
 * share is dropped.
 */
function apiCallToolNames(
  integrationId: string,
  namespace: string,
  manifest: IntegrationManifest,
): Map<string, string> {
  const catalog = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((entry) => entry.name),
  );
  const holders = new Map<string, string[]>();
  for (const config of getApiCallConfigs(manifest)) {
    if (!catalog.has(config.toolName)) continue;
    const name = apiCallToolName(namespace, config.toolName);
    holders.set(name, [...(holders.get(name) ?? []), config.toolName]);
  }
  const names = new Map<string, string>();
  for (const [name, group] of holders) {
    if (group.length === 1) names.set(name, group[0]!);
    else
      logger.warn("credential-proxy: api_call tool name collides, tools dropped", {
        integrationId,
        name,
      });
  }
  return names;
}

interface ListedIntegration {
  id: string;
  namespace: string;
  manifest: IntegrationManifest;
  connections: readonly ConnectionOutsideRun[];
  /** Exposed name → `api_call` tool name. */
  apiCallNames: ReadonlyMap<string, string>;
}

function apiCallTools(entry: ListedIntegration): ApiCallTool[] {
  const { id, namespace, manifest, connections } = entry;
  const configs = getApiCallConfigs(manifest);
  const described = typeof manifest.description === "string" ? manifest.description.trim() : "";
  // A sentence follows it: a description left open is closed.
  const about = `${manifest.display_name ?? manifest.name}.${
    described ? ` ${/[.!?…]$/.test(described) ? described : `${described}.`}` : ""
  }`;
  return configs.flatMap((config): ApiCallTool[] => {
    const name = apiCallToolName(namespace, config.toolName);
    const reached = connections.filter((c) => c.auth_key === config.authKey);
    if (entry.apiCallNames.get(name) !== config.toolName || reached.length === 0) return [];
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
  return exposeRemoteTools(
    entry.id,
    entry.namespace,
    offeredRemoteToolNames(entry.manifest, undefined),
  ).has(name);
}

/**
 * The catalog could not be read to prove what `name` calls, `listing_failure` saying why when
 * known. Retryable: a later listing may read it.
 */
function catalogUnavailable(
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
  const exposed = exposeRemoteTools(
    integrationId,
    namespace,
    catalog.tools.map((upstream) => upstream.name),
  );
  const shown = new Set<string>();
  const tools = catalog.tools.flatMap((upstream): RemoteTool[] => {
    const name = remoteToolName(namespace, upstream.name);
    if (exposed.get(name) !== upstream.name || shown.has(name)) return [];
    shown.add(name);
    return [remoteTool(name, upstream, !catalog.listed)];
  });
  const named = query.name;
  if (
    named !== undefined &&
    !catalog.listed &&
    allowsUndeclaredTools(manifest) &&
    named.startsWith(`${namespace}__`) &&
    !exposed.has(named)
  ) {
    // Its server unread, an undeclared tool is called by the name it was given, when that name
    // is its own; any other name needs the catalog.
    const upstream = selfNamedUpstream(namespace, named);
    if (upstream === undefined) {
      return {
        unlisted: {
          integration_package_id: integrationId,
          refusal: catalogUnavailable(integrationId, named, catalog.listingFailure).toProblemDetail(
            caller.caller.requestId,
          ),
        },
      };
    }
    tools.push(remoteTool(named, { name: upstream, input_schema: { type: "object" } }, true));
  }
  return { tools, truncatedAt: catalog.truncatedAt };
}

/**
 * Every tool the caller may call outside a run in the space, sorted by integration, `api_call`
 * tools first, with the connections they reach, the integrations without a usable connection and
 * the remote ones the proxy refused to list. Read under `reach`, activation checked before any
 * connection is selected; servers are waited for until {@link listingDeadline}.
 */
/** Connecting it gives a tool to call outside a run: an `api_call` tool, or a remote server's. */
function offersToolsOutsideRun(manifest: IntegrationManifest): boolean {
  return manifest.source?.kind === "remote" || getApiCallConfigs(manifest).length > 0;
}

export async function listIntegrationTools(
  caller: RemoteToolsCaller,
  query: IntegrationToolQuery,
): Promise<IntegrationToolListing> {
  const { scope, actor, reach, connectOffers } = caller;
  const listingByName = query.name !== undefined;
  const activeIds = await activeIntegrationIds(scope);
  if (query.integrationId !== undefined && !activeIds.includes(query.integrationId)) {
    throw notFound(`Integration '${query.integrationId}' is not active in this space`);
  }
  const manifests = await publishedManifests(
    scope.orgId,
    query.integrationId !== undefined ? [query.integrationId] : activeIds,
  );
  const reachable = await connectionsOutsideRun(scope, actor, reach, manifests);

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
        apiCallNames: apiCallToolNames(id, namespace, manifest),
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
  // A listing offers a connect link once, in `not_ready`: a refusal read here mints none. A call
  // by name has no `not_ready`, so its refusal keeps the offer.
  const listing = {
    ...caller,
    connectOffers: listingByName ? connectOffers : null,
    signal: AbortSignal.any([caller.signal, listingDeadline(query.name !== undefined)]),
  };
  const listed = new Map(
    await mapWithConcurrency(
      remote,
      LIST_CONCURRENCY,
      async (entry) => [entry.id, await remoteTools(listing, entry, query)] as const,
    ),
  );

  // Judged after the catalog reads: an upstream rejection flags its connection during one.
  const notReady = listingByName
    ? []
    : (
        await integrationsOutsideRun(
          scope,
          actor,
          reach,
          connectOffers,
          new Map([...manifests].filter(([, manifest]) => offersToolsOutsideRun(manifest))),
        )
      ).filter((entry) => NOT_READY_STATUSES.has(entry.proxy_connection.status));
  const notReadyIds = new Set(notReady.map((entry) => entry.integration_package_id));

  const tools: IntegrationTool[] = [];
  const unlisted: UnlistedIntegration[] = [];
  const truncatedCatalogs: TruncatedCatalog[] = [];
  for (const { id } of integrations) {
    tools.push(...httpTools.get(id)!);
    const result = listed.get(id);
    if (result === undefined) continue;
    if ("unlisted" in result) {
      // An integration to reconnect or connect is told once, in `not_ready`.
      if (!notReadyIds.has(id)) unlisted.push(result.unlisted);
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
    not_ready: notReady,
    unlisted,
    truncated_catalogs: query.name === undefined ? truncatedCatalogs : [],
  };
}
