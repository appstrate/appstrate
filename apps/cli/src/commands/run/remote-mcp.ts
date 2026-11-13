// SPDX-License-Identifier: Apache-2.0

/**
 * MCP tools of the unauthenticated remote integrations (AFPS §7.1 `source.kind: "remote"`, §7.2
 * `auths` absent) for `appstrate run` in local mode.
 *
 * Such an integration injects no credential, so the CLI reaches its server directly: one
 * connection per integration, `tools/list`, the agent's effective selection
 * (`integrations_configuration.<id>.tools`, else `default_tools`) and `hidden_tools` applied to
 * the upstream names, then one Pi tool per admitted tool, named `{ns}__{tool}` exactly as the
 * platform sidecar's McpHost names it, in one allocation with the run's `api_call` tools.
 * Admission and descriptors follow the platform's rules (`toolExclusion`,
 * `sanitiseToolDescriptor`, `exposedToolDescriptor`) before they reach the model.
 *
 * An integration bound to the runtime (`isRuntimeBoundIntegration`, e.g. `@appstrate/platform`)
 * takes the same path with another target: the run's MCP server on the instance the run reports
 * to (`/api/runs/{runId}/mcp`), every request signed with the run secret as the run's events are
 * (Standard Webhooks headers over the exact body, a fresh message id and timestamp each), so the
 * tools stay reachable for the whole run. A run that reports to no instance leaves it unbound.
 * Any other integration's requests carry no credential.
 *
 * Every request goes through `guardedFetchChain`, as the CLI's `api_call` engine does: the host
 * of the target URL is the caller's own (a dev server on localhost is reachable), any other host
 * a redirect leads to is checked against the SSRF blocklist, and is sent no signature.
 *
 * The integrations connect concurrently; their tools are named in declaration order, so the
 * allocation does not depend on which server answers first. An integration whose server cannot be
 * reached, does not answer the connection and `tools/list` within
 * {@link REMOTE_MCP_STARTUP_TIMEOUT_MS}, fails its `tools/list` or exposes no admitted tool is
 * returned in `unavailable` with the platform's wording ({@link UNAVAILABLE_INTEGRATION_REASONS}):
 * the run starts without it.
 */

import {
  readIntegrationRefs,
  readIntegrationManifest,
  type IntegrationRef,
} from "@appstrate/afps-runtime/resolvers";
import { UNAVAILABLE_INTEGRATION_REASONS, type Bundle } from "@appstrate/afps-runtime/bundle";
import { sign, type SignedEnvelopeHeaders } from "@appstrate/afps-runtime/events";
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
  isRuntimeBoundIntegration,
  isUnauthenticatedIntegration,
  resolveEffectiveToolSelection,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import {
  createMcpHttpClient,
  exposedToolDescriptor,
  sanitiseToolDescriptor,
  toolExclusion,
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

/** The run's MCP server on the instance it reports to, and the run secret signing its requests. */
export interface RunToolsMcp {
  url: string;
  runSecret: string;
}

interface BuildRemoteMcpExtensionsOptions {
  bundle: Bundle;
  /** Absent when the run reports to no instance. */
  runToolsMcp?: RunToolsMcp;
  /**
   * Exposed names the run's other tools already hold (its `{ns}__api_call…` tools): neither
   * they nor their namespaces are given to a remote integration's tool.
   */
  takenToolNames?: ReadonlySet<string>;
  /** Aborts the connections in flight (the CLI's shutdown signal). */
  signal?: AbortSignal;
  /** DNS resolver of the egress guard. Production omits it. */
  resolveHost?: HostResolver;
  /** Bound on one integration's connection and `tools/list`. Production omits it. */
  startupTimeoutMs?: number;
}

const CLIENT_INFO = { name: "appstrate-cli-remote-integration", version: "0.1.0" };

/**
 * Bound on the connection and `tools/list` of one integration: integrations connect concurrently
 * before the run starts, so a server that accepts the connection and never answers delays the run
 * by this much at most. Tool calls keep the client's default timeout.
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
  const toolNames = new Set(opts.takenToolNames);
  // `{namespace}__{body}`: a normalised namespace never holds `__`.
  const namespaces = new Set([...toolNames].map((name) => name.slice(0, name.indexOf("__"))));

  const targets = readIntegrationRefs(opts.bundle).flatMap((ref) => {
    const target = remoteTarget(opts.bundle, ref, agentTools.get(ref.name), opts.runToolsMcp);
    return target ? [{ ref, target }] : [];
  });
  // In declaration order whatever the order the servers answer in.
  const outcomes = await Promise.all(
    targets.map(async ({ ref, target }): Promise<ConnectionOutcome> => {
      if ("reason" in target) return { ref, reason: target.reason };
      const connected = await connectAndList(target, opts);
      return "reason" in connected
        ? { ref, reason: connected.reason }
        : { ref, target, ...connected };
    }),
  );

  for (const outcome of outcomes) {
    if ("reason" in outcome) {
      unavailable.push({ id: outcome.ref.name, reason: outcome.reason });
      continue;
    }
    const { ref, target, client, tools } = outcome;
    const namespace = allocateMcpToolNamespace(normaliseMcpToolNamespace(ref.name), namespaces);
    const admitted = tools.filter(
      (tool) => toolExclusion(tool.name, target.allowlist, target.hidden) === null,
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
      factories.push(
        remoteToolExtension(client, tool.name, exposedToolDescriptor(sanitised, namespace, name)),
      );
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

type ConnectionOutcome =
  | { ref: IntegrationRef; reason: string }
  | {
      ref: IntegrationRef;
      target: Exclude<RemoteTarget, { reason: string }>;
      client: AppstrateMcpClient;
      tools: Tool[];
    };

/** The signature headers of one request, computed over the exact body it sends. */
type RequestSigner = (body: string) => SignedEnvelopeHeaders;

type RemoteTarget =
  | {
      url: string;
      /** Set for the run's own MCP server only: no other target is sent a credential. */
      signRequest?: RequestSigner;
      allowlist: ReadonlySet<string> | null;
      hidden: ReadonlySet<string>;
    }
  | { reason: string };

/**
 * The server, request signer and tool filters of `ref` when it is an unauthenticated remote
 * integration the agent selects at least one tool of; `undefined` for any other integration.
 * `allowlist: null` is the `"*"` wildcard: every upstream tool but the hidden ones.
 */
function remoteTarget(
  bundle: Bundle,
  ref: IntegrationRef,
  agentSelection: readonly string[] | "*" | undefined,
  runToolsMcp: BuildRemoteMcpExtensionsOptions["runToolsMcp"],
): RemoteTarget | undefined {
  const manifest = readIntegrationManifest(bundle, ref) as IntegrationManifest | undefined;
  if (!manifest || typeof manifest !== "object") return undefined;
  const source = manifest.source as
    { kind?: unknown; remote?: { url?: unknown; transport?: unknown } } | undefined;
  if (source?.kind !== "remote" || !isUnauthenticatedIntegration(manifest)) return undefined;
  const selection = resolveEffectiveToolSelection(agentSelection, manifest);
  const wildcard = isToolsWildcard(selection);
  if (!wildcard && !selection?.length) return undefined;
  const filters = {
    allowlist: wildcard ? null : new Set(selection),
    hidden: new Set(manifest.hidden_tools ?? []),
  };

  if (isRuntimeBoundIntegration(manifest)) {
    if (!runToolsMcp) return { reason: UNAVAILABLE_INTEGRATION_REASONS.unbound };
    const { url, runSecret } = runToolsMcp;
    // What `HttpSink` sends with each event: a fresh message id and timestamp per request.
    const signRequest: RequestSigner = (body) =>
      sign({
        msgId: crypto.randomUUID(),
        timestampSec: Math.floor(Date.now() / 1000),
        body,
        secret: runSecret,
      });
    return { url, signRequest, ...filters };
  }

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
  return { url, ...filters };
}

/** One connection and its complete `tools/list`, or the reason the integration is unavailable. */
async function connectAndList(
  { url, signRequest }: { url: string; signRequest?: RequestSigner },
  opts: BuildRemoteMcpExtensionsOptions,
): Promise<{ client: AppstrateMcpClient; tools: Tool[] } | { reason: string }> {
  const declaredHost = new URL(url).hostname;
  const guardedFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      // The MCP client calls `fetch(url, init)`: a `Request` would carry a method, body and
      // headers this wrapper does not read.
      if (input instanceof Request) {
        throw new TypeError("remote MCP fetch takes a URL, not a Request");
      }
      const { response } = await guardedFetchChain(
        input,
        signRequest ? signed(init, signRequest) : init,
        {
          allowHost: (host) => host === declaredHost,
          // A redirect to another origin is sent no signature.
          sensitiveHeaders: SIGNATURE_HEADERS,
          ...(opts.resolveHost ? { resolve: opts.resolveHost } : {}),
        },
      );
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

const SIGNATURE_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;

/**
 * `init` with the signature headers of its body; a request without a body (a GET or DELETE of the
 * MCP client) is signed over the empty body.
 */
function signed(init: RequestInit | undefined, signRequest: RequestSigner): RequestInit {
  const body = init?.body ?? "";
  if (typeof body !== "string") throw new TypeError("a signed MCP request carries a string body");
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(signRequest(body))) headers.set(name, value);
  return { ...init, headers };
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
        // Requesting progress makes the client's per-call timeout an idle one, restarted by
        // each notification (and capped in total): a long call that reports progress is not
        // cut. Nothing else reads the notifications.
        const result = await client.callTool(
          { name: upstreamName, arguments: (params as Record<string, unknown>) ?? {} },
          { ...(signal ? { signal } : {}), onProgress: () => {} },
        );
        return callToolResultToPi(result);
      },
    });
  };
}
