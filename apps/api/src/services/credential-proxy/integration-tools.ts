// SPDX-License-Identifier: Apache-2.0

/**
 * The tools a caller may call outside a run in a space, named as they are called: each
 * integration's `api_call` tools (`{ns}__api_call`, `{ns}__api_call__{auth}` when several of its
 * auths expose one), reached through `/api/credential-proxy/proxy`, and the typed tools of a
 * remote MCP server (`{ns}__{tool}`), read by `listRemoteTools` and reached through
 * `callRemoteTool`. Each tool carries the connections it reaches, as the proxy's listing gives
 * them, a typed tool's with the scopes its `tools_policy` entry requires that the connection
 * lacks. The integrations active here that the caller has no usable connection of come apart.
 *
 * A namespace is the package id normalised (`normaliseMcpToolNamespace`); package ids that
 * normalise alike each take a suffix hashed from their own id, so a tool's name depends on its
 * integration alone, never on which other connections the caller holds.
 */

import {
  getApiCallConfigs,
  missingScopesForConnection,
  resolveIntegrationToolCatalog,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { allocateMcpToolName, normaliseMcpToolNamespace } from "@appstrate/core/naming";
import { fnv1a64Hex } from "@appstrate/afps-shared/mcp-naming";
import type { ProblemDetail } from "@appstrate/core/api-errors";
import { ApiError, type ResolutionFieldError } from "../../lib/errors.ts";
import type { ProxyConnectionStatus } from "../integration-connections.ts";
import {
  connectionsOutsideRun,
  listIntegrationsOutsideRun,
  type ConnectionOutsideRun,
} from "./integration-resolver.ts";
import { listRemoteTools, type RemoteToolCatalog, type RemoteToolsCaller } from "./remote-tools.ts";

/** One connection a tool reaches. */
export type ToolConnection = Omit<ConnectionOutsideRun, "integration_package_id"> & {
  /** Typed tool only: the scopes its `tools_policy` entry requires on this auth that it lacks. */
  missing_scopes?: string[];
};

interface ToolBase {
  /** The name the tool is called by. */
  name: string;
  integration_package_id: string;
  description: string;
  connections: ToolConnection[];
}

/** A tool reached through `/api/credential-proxy/proxy`. */
interface ApiCallTool extends ToolBase {
  kind: "api_call";
  /** The auth whose connections it reaches. */
  auth_key: string;
  /** The integration also has connections of another auth: a call names one of `connections`. */
  connection_required: boolean;
}

/** A typed tool of a remote MCP server, reached through `/api/credential-proxy/tools/call`. */
interface RemoteTool extends ToolBase {
  kind: "remote";
  /** The name the server lists it by: `tools/call` takes it. */
  remote_name: string;
  input_schema: Record<string, unknown>;
  /** The server could not be listed: the tool is declared, without description or schema. */
  catalog_unreadable?: true;
}

export type IntegrationTool = ApiCallTool | RemoteTool;

/** An integration active here that the caller has no usable connection of. */
interface NotReadyIntegration {
  integration_package_id: string;
  display_name: string;
  proxy_connection: { status: ProxyConnectionStatus; imposed: boolean };
  /** The selection's item, with its `connect_url` when the caller asked for one. */
  refusal?: ResolutionFieldError;
}

/** A remote integration whose server the proxy refused to list. */
interface UnlistedIntegration {
  integration_package_id: string;
  refusal: ProblemDetail;
}

export interface IntegrationToolListing {
  tools: IntegrationTool[];
  not_ready: NotReadyIntegration[];
  unlisted: UnlistedIntegration[];
}

interface IntegrationToolQuery {
  /** Lists this integration alone. */
  integrationId?: string;
  /**
   * Resolves the tool of this name alone: an `api_call` tool reads no server, and only the remote
   * integrations whose namespace starts the name are listed. `not_ready` is then left empty.
   */
  name?: string;
  /** The connection a remote integration it belongs to is listed with. */
  connectionId?: string;
}

/**
 * The `proxy_connection` statuses of an integration without a usable connection: a call naming
 * none is refused, and no connection a call could name instead clears it.
 */
const NOT_READY_STATUSES: ReadonlySet<ProxyConnectionStatus> = new Set([
  "none",
  "needs_reconnection",
  "not_permitted",
  "default_unavailable",
  "unusable",
]);

/** Remote servers listed at once. */
const LIST_CONCURRENCY = 3;
/** Hex digits of the package id's hash a colliding namespace takes. */
const NAMESPACE_HASH_LENGTH = 6;

/** The namespace of each integration: its normalised id, hashed apart when another shares it. */
function namespacesOf(ids: readonly string[]): Map<string, string> {
  const bases = new Map(ids.map((id) => [id, normaliseMcpToolNamespace(id)]));
  const holders = new Map<string, number>();
  for (const base of bases.values()) holders.set(base, (holders.get(base) ?? 0) + 1);
  return new Map(
    ids.map((id) => {
      const base = bases.get(id)!;
      return [
        id,
        holders.get(base) === 1
          ? base
          : `${base}_${fnv1a64Hex(id).slice(0, NAMESPACE_HASH_LENGTH)}`,
      ];
    }),
  );
}

/** The `api_call` tools of one integration whose auth has a connection. */
function apiCallTools(
  integrationId: string,
  namespace: string,
  manifest: IntegrationManifest,
  connections: readonly ToolConnection[],
): ApiCallTool[] {
  const catalog = new Set(
    resolveIntegrationToolCatalog({ integration: manifest }).map((entry) => entry.name),
  );
  const configs = getApiCallConfigs(manifest);
  const about = `${manifest.display_name ?? manifest.name}.${
    typeof manifest.description === "string" ? ` ${manifest.description}` : ""
  }`;
  return configs.flatMap((config): ApiCallTool[] => {
    const reached = connections.filter((c) => c.auth_key === config.authKey);
    if (!catalog.has(config.toolName) || reached.length === 0) return [];
    return [
      {
        kind: "api_call",
        name: `${namespace}__${config.toolName}`,
        integration_package_id: integrationId,
        description: configs.length > 1 ? `${about} Uses its \`${config.authKey}\` auth.` : about,
        auth_key: config.authKey,
        connection_required: reached.length < connections.length,
        connections: reached,
      },
    ];
  });
}

/**
 * The server's catalog, listed with the connection named when it is one of `connections`, else
 * with the proxy's selection; when that selection asks for a choice, with the first of
 * `connections` the proxy accepts.
 */
async function readRemoteCatalog(
  caller: RemoteToolsCaller,
  integrationId: string,
  connections: readonly ToolConnection[],
  connectionId: string | undefined,
): Promise<RemoteToolCatalog> {
  const named = connections.find(
    (c) => c.connection_id.toLowerCase() === connectionId?.toLowerCase(),
  );
  const list = (id: string | undefined) =>
    listRemoteTools({ ...caller, integrationId, ...(id ? { connectionId: id } : {}) });
  try {
    return await list(named?.connection_id);
  } catch (err) {
    if (named || !(err instanceof ApiError) || err.code !== "must_choose_connection") throw err;
    for (const connection of connections) {
      try {
        return await list(connection.connection_id);
      } catch {
        // The next connection may serve.
      }
    }
    throw err;
  }
}

/** The typed tools a remote integration's server offers, or the proxy's refusal to list it. */
async function remoteTools(
  caller: RemoteToolsCaller,
  integrationId: string,
  namespace: string,
  manifest: IntegrationManifest,
  connections: readonly ToolConnection[],
  taken: Set<string>,
  connectionId: string | undefined,
): Promise<RemoteTool[] | UnlistedIntegration> {
  let catalog: RemoteToolCatalog;
  try {
    catalog = await readRemoteCatalog(caller, integrationId, connections, connectionId);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      integration_package_id: integrationId,
      refusal: err.toProblemDetail(caller.caller.requestId),
    };
  }
  const about = manifest.display_name ?? manifest.name;
  return catalog.tools.flatMap((upstream): RemoteTool[] => {
    let name: string;
    try {
      name = allocateMcpToolName(namespace, upstream.name, (n) => taken.has(n));
    } catch {
      return [];
    }
    taken.add(name);
    return [
      {
        kind: "remote",
        name,
        integration_package_id: integrationId,
        description: upstream.description ? `${about}. ${upstream.description}` : `${about}.`,
        remote_name: upstream.name,
        input_schema: upstream.input_schema,
        ...(catalog.listed ? {} : { catalog_unreadable: true as const }),
        connections: connections.map((connection) => ({
          ...connection,
          missing_scopes: missingScopesForConnection({
            manifest,
            authKey: connection.auth_key,
            granted: connection.scopes_granted,
            agentTools: [upstream.name],
            agentScopes: [],
          }),
        })),
      },
    ];
  });
}

/**
 * Every tool the caller may call outside a run in the space, sorted by integration, `api_call`
 * tools first within one; the integrations active here without a usable connection, under the
 * connect-offer policy of the caller (`connectOffers`); and the remote integrations whose server
 * the proxy refused to list, with that refusal. Read under the access rule of
 * `/api/credential-proxy/proxy` without a run (`reach`).
 */
export async function listIntegrationTools(
  caller: RemoteToolsCaller,
  query: IntegrationToolQuery = {},
): Promise<IntegrationToolListing> {
  const { scope, actor, reach, connectOffers } = caller;
  const [reachable, notReady] = await Promise.all([
    connectionsOutsideRun(scope, actor, reach),
    query.name === undefined
      ? listIntegrationsOutsideRun(scope, actor, reach, connectOffers, query.integrationId)
      : [],
  ]);

  const byIntegration = new Map<string, ToolConnection[]>();
  for (const { integration_package_id: id, ...connection } of reachable.connections) {
    byIntegration.set(id, [...(byIntegration.get(id) ?? []), connection]);
  }
  // Every integration listed takes its namespace, whichever one the query keeps.
  const namespaces = namespacesOf([...byIntegration.keys()]);
  const integrations = [...byIntegration]
    .filter(([id]) => query.integrationId === undefined || id === query.integrationId)
    .flatMap(([id, connections]) => {
      const manifest = reachable.manifests.get(id);
      return manifest ? [{ id, namespace: namespaces.get(id)!, manifest, connections }] : [];
    });

  const httpTools = new Map(
    integrations.map((entry) => [
      entry.id,
      apiCallTools(entry.id, entry.namespace, entry.manifest, entry.connections),
    ]),
  );
  const named = (tools: IntegrationTool[]) =>
    query.name === undefined ? tools : tools.filter((tool) => tool.name === query.name);
  const httpMatch = named([...httpTools.values()].flat());
  if (query.name !== undefined && httpMatch.length > 0) {
    return { tools: httpMatch, not_ready: [], unlisted: [] };
  }

  const remote = integrations.filter(
    (entry) =>
      entry.manifest.source?.kind === "remote" &&
      (query.name === undefined || query.name.startsWith(`${entry.namespace}__`)),
  );
  const listed = new Map(
    await mapWithConcurrency(remote, LIST_CONCURRENCY, async (entry) => {
      const taken = new Set(httpTools.get(entry.id)!.map((tool) => tool.name));
      const result = await remoteTools(
        caller,
        entry.id,
        entry.namespace,
        entry.manifest,
        entry.connections,
        taken,
        query.connectionId,
      );
      return [entry.id, result] as const;
    }),
  );

  const tools: IntegrationTool[] = [];
  const unlisted: UnlistedIntegration[] = [];
  for (const { id } of integrations) {
    tools.push(...httpTools.get(id)!);
    const result = listed.get(id);
    if (result === undefined) continue;
    if (Array.isArray(result)) tools.push(...result);
    else unlisted.push(result);
  }
  return {
    tools: named(tools),
    not_ready: notReady.flatMap(
      ({ integration_package_id, display_name, proxy_connection, refusal }) =>
        NOT_READY_STATUSES.has(proxy_connection.status)
          ? [
              {
                integration_package_id,
                display_name,
                proxy_connection,
                ...(refusal ? { refusal } : {}),
              },
            ]
          : [],
    ),
    unlisted,
  };
}
