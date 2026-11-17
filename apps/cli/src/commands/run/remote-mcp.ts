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
 * Admission and descriptors follow the platform's rules (`toolExclusion`, `exposeTool`) before
 * they reach the model; each tool spills its resources to the run's workspace and reports its
 * calls as events.
 *
 * An integration bound to the runtime (`isRuntimeBoundIntegration`, e.g. `@appstrate/platform`)
 * takes the same path with another target: the run's MCP server on the instance the run reports
 * to (`/api/runs/{id}/mcp`), every request signed with the run secret as the run's events are
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
 * returned in `unavailable` with the platform's wording ({@link UNAVAILABLE_INTEGRATION_REASONS}),
 * and the cause in `detail`: the run starts without it.
 */

import {
  readIntegrationRefs,
  readIntegrationManifest,
  type IntegrationRef,
} from "@appstrate/afps-runtime/resolvers";
import { UNAVAILABLE_INTEGRATION_REASONS, type Bundle } from "@appstrate/afps-runtime/bundle";
import { signFresh, type SignedEnvelopeHeaders } from "@appstrate/afps-runtime/events";
import { renderUrlTemplate } from "@appstrate/afps-shared/connection-variables";
import { guardedFetchChain, SsrfBlockedError } from "@appstrate/afps-shared/guarded-fetch";
import {
  allocateMcpToolNamespace,
  normaliseMcpToolNamespace,
} from "@appstrate/afps-shared/mcp-naming";
import { parseManifestIntegrations, isToolsWildcard } from "@appstrate/core/dependencies";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  getIntegrationSourceKind,
  getRemoteSource,
  isRuntimeBoundIntegration,
  isUnauthenticatedIntegration,
  resolveEffectiveToolSelection,
  type IntegrationManifest,
} from "@appstrate/core/integration";
import {
  createMcpHttpClient,
  exposeTool,
  mcpFetch,
  toolExclusion,
  type AppstrateMcpClient,
  type Tool,
} from "@appstrate/mcp-transport";
import {
  mcpToolForwardFactory,
  type ExtensionFactory,
  type RuntimeEventEmitter,
} from "@appstrate/runner-pi";
import { CLI_VERSION } from "../../lib/version.ts";

export interface RemoteMcpExtensions {
  factories: ExtensionFactory[];
  /** Integrations at least one tool was wired for: the ones the agent can call. */
  integrationIds: ReadonlySet<string>;
  /** Integrations the run starts without: `reason` worded for the prompt, `detail` the cause. */
  unavailable: UnavailableIntegration[];
  /** Closes every connection opened; the run's cleanup calls it once. */
  close(): Promise<void>;
}

interface UnavailableIntegration {
  id: string;
  reason: string;
  detail?: string;
}

/** The run's MCP server on the instance it reports to, and the run secret signing its requests. */
interface RunToolsMcp {
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
  takenToolNames: ReadonlySet<string>;
  runId: string;
  /** Workspace root the tools' resources spill under. */
  workspace: string;
  /** Receives each tool call's `integration_tool.*` and `resource.spilled` events. */
  emit: RuntimeEventEmitter;
  /** Aborts the connections in flight (the CLI's shutdown signal). */
  signal?: AbortSignal;
  /** Bound on one integration's connection and `tools/list`. Production omits it. */
  startupTimeoutMs?: number;
}

const CLIENT_INFO = { name: "appstrate-cli-remote-integration", version: CLI_VERSION };

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
  const unavailable: UnavailableIntegration[] = [];
  const clients: AppstrateMcpClient[] = [];
  const closed = new Set<AppstrateMcpClient>();
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
      if ("reason" in target) return { ref, unavailable: target };
      const connected = await connectAndList(target, opts);
      return "reason" in connected
        ? { ref, unavailable: connected }
        : { ref, target, ...connected };
    }),
  );

  try {
    for (const outcome of outcomes) {
      if ("unavailable" in outcome) {
        unavailable.push({ id: outcome.ref.name, ...outcome.unavailable });
        continue;
      }
      const { ref, target, client, tools } = outcome;
      const namespace = allocateMcpToolNamespace(normaliseMcpToolNamespace(ref.name), namespaces);
      const before = factories.length;
      for (const tool of tools) {
        if (toolExclusion(tool.name, target.allowlist, target.hidden)) continue;
        const exposure = exposeTool(tool, {
          integrationId: ref.name,
          namespace,
          isTaken: (name) => toolNames.has(name),
        });
        if ("exclusion" in exposure) continue;
        toolNames.add(exposure.descriptor.name);
        factories.push(
          mcpToolForwardFactory({
            mcp: client,
            tool: exposure.descriptor,
            upstreamName: tool.name,
            runId: opts.runId,
            workspace: opts.workspace,
            emit: opts.emit,
          }),
        );
      }
      if (factories.length === before) {
        closed.add(client);
        await client.close().catch(() => {});
        unavailable.push({
          id: ref.name,
          reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
          detail: "its server exposes none of the selected tools",
        });
        continue;
      }
      namespaces.add(namespace);
      clients.push(client);
      integrationIds.add(ref.name);
    }
  } catch (err) {
    // A throw leaves no caller holding the connected clients.
    await Promise.all(
      outcomes.flatMap((outcome) =>
        "client" in outcome && !closed.has(outcome.client) ? [outcome.client.close()] : [],
      ),
    ).catch(() => {});
    throw err;
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

/** Why an integration is unavailable: `reason` for the prompt, `detail` for the person. */
type Unavailability = Omit<UnavailableIntegration, "id">;

type ConnectionOutcome =
  | { ref: IntegrationRef; unavailable: Unavailability }
  | {
      ref: IntegrationRef;
      target: Exclude<RemoteTarget, Unavailability>;
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
      /** `legacy` for the run's own MCP server, built by `createMcpServer`: no era probe. */
      era?: "legacy";
      allowlist: ReadonlySet<string> | null;
      hidden: ReadonlySet<string>;
    }
  | Unavailability;

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
  if (getIntegrationSourceKind(manifest) !== "remote" || !isUnauthenticatedIntegration(manifest)) {
    return undefined;
  }
  const selection = resolveEffectiveToolSelection(agentSelection, manifest);
  const wildcard = isToolsWildcard(selection);
  if (!wildcard && !selection?.length) return undefined;
  const filters = {
    allowlist: wildcard ? null : new Set(selection),
    hidden: new Set(manifest.hidden_tools ?? []),
  };

  if (isRuntimeBoundIntegration(manifest)) {
    if (!runToolsMcp) {
      return {
        reason: UNAVAILABLE_INTEGRATION_REASONS.unbound,
        detail: "the run reports to no instance",
      };
    }
    const { url, runSecret } = runToolsMcp;
    const signRequest: RequestSigner = (body) => signFresh({ body, secret: runSecret });
    return { url, signRequest, era: "legacy", ...filters };
  }

  const source = getRemoteSource(manifest);
  if (!source) return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_source_invalid };
  // An unauthenticated integration binds no connection, so a `{$variable.<name>}` template
  // (AFPS §7.12) has no value to render.
  const url = renderUrlTemplate(source.url, {});
  if (url === null) {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_url_unrenderable };
  }
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.remote_source_invalid };
  }
  if (source.transport !== "streamable-http") {
    return {
      reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
      detail: "the CLI speaks Streamable HTTP only; an SSE server is reached by the sidecar alone",
    };
  }
  return { url, ...filters };
}

/** One connection and its complete `tools/list`, or the reason the integration is unavailable. */
async function connectAndList(
  { url, signRequest, era }: { url: string; signRequest?: RequestSigner; era?: "legacy" },
  opts: BuildRemoteMcpExtensionsOptions,
): Promise<{ client: AppstrateMcpClient; tools: Tool[] } | Unavailability> {
  const declaredHost = new URL(url).hostname;
  const guardedFetch = mcpFetch(async (input, init) => {
    const { response } = await guardedFetchChain(
      input,
      signRequest ? signed(init, signRequest) : init,
      {
        allowHost: (host) => host === declaredHost,
        // A redirect to another origin is sent no signature.
        sensitiveHeaders: SIGNATURE_HEADERS,
      },
    );
    return response;
  });
  const deadline = AbortSignal.timeout(opts.startupTimeoutMs ?? REMOTE_MCP_STARTUP_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  let client: AppstrateMcpClient;
  try {
    client = await createMcpHttpClient(url, {
      fetch: guardedFetch,
      clientInfo: CLIENT_INFO,
      signal,
      ...(era ? { era } : {}),
    });
  } catch (err) {
    return {
      reason:
        err instanceof SsrfBlockedError
          ? UNAVAILABLE_INTEGRATION_REASONS.remote_url_blocked
          : UNAVAILABLE_INTEGRATION_REASONS.resolve_error,
      detail: getErrorMessage(err),
    };
  }
  try {
    const { tools } = await client.listTools({ signal });
    return { client, tools };
  } catch (err) {
    await client.close().catch(() => {});
    return { reason: UNAVAILABLE_INTEGRATION_REASONS.resolve_error, detail: getErrorMessage(err) };
  }
}

const SIGNATURE_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"] as const;

/** `init` with the signature headers of its string body. */
function signed(
  init: RequestInit | undefined,
  signRequest: RequestSigner,
): RequestInit | undefined {
  // The server answers a bodiless GET or DELETE 405 before checking any signature.
  if (typeof init?.body !== "string") return init;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(signRequest(init.body))) headers.set(name, value);
  return { ...init, headers };
}
