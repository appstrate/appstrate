// SPDX-License-Identifier: Apache-2.0

/**
 * MCP tools of the unauthenticated remote integrations (AFPS §7.1 `source.kind: "remote"`, §7.2
 * `auths` absent) for `appstrate run` in local mode.
 *
 * Such an integration injects no credential, so the CLI reaches its server directly: one
 * connection per integration, `tools/list`, the agent's effective selection
 * (`integrations_configuration.<id>.tools`, else `default_tools`) and `hidden_tools` applied to
 * the upstream names, then one Pi tool per admitted tool, named `{ns}__{tool}` exactly as the
 * platform sidecar's McpHost names it. Descriptors pass the same sanitiser as on the platform
 * before they reach the model.
 *
 * Every request goes through `guardedFetchChain`, as the CLI's `api_call` engine does: the host
 * the manifest names in `source.remote.url` is the caller's own (a dev server on localhost is
 * reachable), any other host a redirect leads to is checked against the SSRF blocklist.
 *
 * An integration whose server cannot be reached, does not answer the connection and `tools/list`
 * within {@link REMOTE_MCP_STARTUP_TIMEOUT_MS}, fails its `tools/list` or exposes no admitted tool
 * is returned in `unavailable` with the platform's wording
 * ({@link UNAVAILABLE_INTEGRATION_REASONS}): the run starts without it.
 */

import {
  readIntegrationRefs,
  readIntegrationManifest,
  type IntegrationRef,
} from "@appstrate/afps-runtime/resolvers";
import { UNAVAILABLE_INTEGRATION_REASONS, type Bundle } from "@appstrate/afps-runtime/bundle";
import { renderUrlTemplate } from "@appstrate/afps-shared/connection-variables";
import { guardedFetchChain, SsrfBlockedError } from "@appstrate/afps-shared/guarded-fetch";
import type { HostResolver } from "@appstrate/afps-shared/ssrf-dns";
import {
  allocateMcpToolName,
  allocateMcpToolNamespace,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";
import { parseManifestIntegrations, isToolsWildcard } from "@appstrate/core/dependencies";
import {
  isUnauthenticatedIntegration,
  resolveEffectiveToolSelection,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import {
  createMcpHttpClient,
  sanitiseTextField,
  sanitiseToolDescriptor,
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_TOOL_DESCRIPTION_BYTES,
  type AppstrateMcpClient,
  type Tool,
} from "@appstrate/mcp-transport";
import { callToolResultToPi, unsafeSchema, type ExtensionFactory } from "@appstrate/runner-pi";

export interface RemoteMcpExtensions {
  factories: ExtensionFactory[];
  /** Integrations at least one tool was wired for: the ones the agent can call. */
  integrationIds: ReadonlySet<string>;
  /** Integrations the run starts without, worded for the prompt. */
  unavailable: Array<{ id: string; reason: string }>;
  /** Closes every connection opened; the run's cleanup calls it once. */
  close(): Promise<void>;
}

interface BuildRemoteMcpExtensionsOptions {
  bundle: Bundle;
  /** Aborts the connections in flight (the CLI's shutdown signal). */
  signal?: AbortSignal;
  /** DNS resolver of the egress guard. Production omits it. */
  resolveHost?: HostResolver;
  /** Bound on one integration's connection and `tools/list`. Production omits it. */
  startupTimeoutMs?: number;
}

const CLIENT_INFO = { name: "appstrate-cli-remote-integration", version: "0.1.0" };

/**
 * Bound on the connection and `tools/list` of one integration: integrations connect one after the
 * other before the run starts, so a server that accepts the connection and never answers delays
 * the run by this much at most. Tool calls keep the client's default timeout.
 */
const REMOTE_MCP_STARTUP_TIMEOUT_MS = 10_000;

/** Connect every unauthenticated remote integration the agent selects tools of. */
export async function buildRemoteMcpExtensions(
  opts: BuildRemoteMcpExtensionsOptions,
): Promise<RemoteMcpExtensions> {
  const root = opts.bundle.packages.get(opts.bundle.root)?.manifest;
  const agentTools = new Map(
    parseManifestIntegrations((root ?? {}) as Record<string, unknown>).map((e) => [e.id, e.tools]),
  );
  const factories: ExtensionFactory[] = [];
  const integrationIds = new Set<string>();
  const unavailable: Array<{ id: string; reason: string }> = [];
  const clients: AppstrateMcpClient[] = [];
  const namespaces = new Set<string>();
  const toolNames = new Set<string>();

  for (const ref of readIntegrationRefs(opts.bundle)) {
    const target = remoteTarget(opts.bundle, ref, agentTools.get(ref.name));
    if (!target) continue;
    if ("reason" in target) {
      unavailable.push({ id: ref.name, reason: target.reason });
      continue;
    }
    const connected = await connectAndList(target.url, opts);
    if ("reason" in connected) {
      unavailable.push({ id: ref.name, reason: connected.reason });
      continue;
    }
    const { client, tools } = connected;
    const namespace = allocateMcpToolNamespace(normaliseMcpToolNamespace(ref.name), namespaces);
    const admitted = tools.filter(
      (tool) =>
        (target.allowlist === null || target.allowlist.has(tool.name)) &&
        !target.hidden.has(tool.name),
    );
    const before = factories.length;
    for (const tool of admitted) {
      const sanitised = sanitiseToolDescriptor(tool);
      if (!sanitised) continue;
      let name: string;
      try {
        name = allocateMcpToolName(namespace, tool.name, (candidate) => toolNames.has(candidate));
      } catch {
        // An unresolvable collision costs that one tool, as on the platform.
        continue;
      }
      toolNames.add(name);
      const descriptor = exposedDescriptor(sanitised, name, name !== `${namespace}__${tool.name}`);
      factories.push(remoteToolExtension(client, tool.name, descriptor));
    }
    if (factories.length === before) {
      await client.close().catch(() => {});
      unavailable.push({ id: ref.name, reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error });
      continue;
    }
    namespaces.add(namespace);
    clients.push(client);
    integrationIds.add(ref.name);
  }

  return {
    factories,
    integrationIds,
    unavailable,
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}

type RemoteTarget =
  | { url: string; allowlist: ReadonlySet<string> | null; hidden: ReadonlySet<string> }
  | { reason: string };

/**
 * The server and tool filters of `ref` when it is an unauthenticated remote integration the agent
 * selects at least one tool of; `undefined` for any other integration. `allowlist: null` is the
 * `"*"` wildcard: every upstream tool but the hidden ones.
 */
function remoteTarget(
  bundle: Bundle,
  ref: IntegrationRef,
  agentSelection: readonly string[] | "*" | undefined,
): RemoteTarget | undefined {
  const manifest = readIntegrationManifest(bundle, ref) as IntegrationManifest | undefined;
  if (!manifest || typeof manifest !== "object") return undefined;
  const source = manifest.source as
    { kind?: unknown; remote?: { url?: unknown; transport?: unknown } } | undefined;
  if (source?.kind !== "remote" || !isUnauthenticatedIntegration(manifest)) return undefined;
  const selection = resolveEffectiveToolSelection(agentSelection, manifest);
  const wildcard = isToolsWildcard(selection);
  if (!wildcard && !selection?.length) return undefined;

  if (typeof source.remote?.url !== "string") {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_source_invalid };
  }
  // An unauthenticated integration binds no connection, so a `{$variable.<name>}` template
  // (AFPS §7.12) has no value to render.
  const url = renderUrlTemplate(source.remote.url, {});
  if (url === null) {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_url_unrenderable };
  }
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_source_invalid };
  }
  // The CLI client speaks Streamable HTTP only; an SSE server is reached by the sidecar alone.
  if (source.remote?.transport !== "streamable-http") {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error };
  }
  return {
    url,
    allowlist: wildcard ? null : new Set(selection),
    hidden: new Set(manifest.hidden_tools ?? []),
  };
}

/** One connection and its complete `tools/list`, or the reason the integration is unavailable. */
async function connectAndList(
  url: string,
  opts: BuildRemoteMcpExtensionsOptions,
): Promise<{ client: AppstrateMcpClient; tools: Tool[] } | { reason: string }> {
  const declaredHost = new URL(url).hostname;
  const guardedFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const href = typeof input === "string" || input instanceof URL ? input : input.url;
      const { response } = await guardedFetchChain(href, init, {
        allowHost: (host) => host === declaredHost,
        ...(opts.resolveHost ? { resolve: opts.resolveHost } : {}),
      });
      return response;
    },
    { preconnect: fetch.preconnect },
  );
  const deadline = AbortSignal.timeout(opts.startupTimeoutMs ?? REMOTE_MCP_STARTUP_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let client: AppstrateMcpClient;
  try {
    client = await createMcpHttpClient(url, {
      fetch: guardedFetch,
      clientInfo: CLIENT_INFO,
      signal,
    });
  } catch (err) {
    return {
      reason:
        err instanceof SsrfBlockedError
          ? UNAVAILABLE_INTEGRATION_REASONS.remote_url_blocked
          : UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
    };
  }
  try {
    const { tools } = await client.listTools({ signal });
    return { client, tools };
  } catch {
    await client.close().catch(() => {});
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error };
  }
}

/**
 * The descriptor the model sees under `name`. A `renamed` tool (not `{ns}__{upstream}`) gives
 * the upstream name in the description, as McpHost does, so the model can match the tool against
 * the server's own documentation.
 */
function exposedDescriptor(sanitised: Tool, name: string, renamed: boolean): Tool {
  if (!renamed) return { ...sanitised, name };
  const upstreamName = JSON.stringify(
    sanitiseTextField(sanitised.name, MAX_PARAMETER_DESCRIPTION_BYTES),
  );
  return {
    ...sanitised,
    name,
    description: sanitiseTextField(
      `Upstream tool name: ${upstreamName}.${sanitised.description ? `\n\n${sanitised.description}` : ""}`,
      MAX_TOOL_DESCRIPTION_BYTES,
    ),
  };
}

/** A Pi tool forwarding every call verbatim to `upstreamName` on the integration's server. */
function remoteToolExtension(
  client: AppstrateMcpClient,
  upstreamName: string,
  descriptor: Tool,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description ?? `Integration tool: ${descriptor.name}`,
      parameters: unsafeSchema<Record<string, unknown>>(
        (descriptor.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      ),
      async execute(_toolCallId, params, signal) {
        const result = await client.callTool(
          { name: upstreamName, arguments: (params as Record<string, unknown>) ?? {} },
          { ...(signal ? { signal } : {}), onProgress: () => {} },
        );
        return callToolResultToPi(result);
      },
    });
  };
}
