// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar-side integration bootstrap (Phase 1.4 + 1.5).
 *
 * Reads the `INTEGRATIONS_TO_SPAWN_JSON` env var produced by the
 * platform launcher (see `apps/api/src/services/run-launcher/pi.ts`),
 * fetches each integration's bundle bytes via the internal credentials
 * surface, materialises them on local fs, spawns the declared MCP
 * subprocess through the selected {@link IntegrationRuntimeAdapter}
 * (Docker container by default, in-process fallback for dev/tests,
 * future: Firecracker microVM, podman, …), and aggregates their tools
 * on a shared {@link McpHost}.
 *
 * Phase 1.5 also wires per-integration HTTPS MITM listeners for auths
 * that declare `delivery.http`: a per-run CA is minted on boot, each
 * such integration gets a credentials source (cache + refresh hook) +
 * listener bound on the adapter's preferred interface, and the listener
 * injects the configured header on outbound calls. The runner reaches
 * the listener via the URL the adapter computed.
 *
 * Boundaries this module deliberately does NOT cross:
 *
 *   - HOW the integration's MCP server is spawned (container, subprocess,
 *     VM) is the {@link IntegrationRuntimeAdapter}'s concern.
 *   - WHERE the runner reaches the MITM listener (DNS alias, loopback,
 *     gateway) is the adapter's concern.
 *   - Restart-on-crash supervision is deferred to a later phase; today
 *     a crashed integration surfaces as a tool-error on the next call.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";

import { guardedFetch } from "@appstrate/core/ssrf";
import { isOperatorTrustedEgressHost } from "./ssrf.ts";
import { unzipBounded } from "@appstrate/core/zip";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createInProcessPair,
  createMcpHttpClient,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { planCaBundle, type CaBundle } from "@appstrate/connect/proxy-ca-planner";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import type { BrowserAcquisitionResult, CredentialBundle } from "@appstrate/connect/connect";

import { McpHost } from "./mcp-host.ts";
import { logger } from "./logger.ts";
import type { HostResolver } from "./helpers.ts";
import { createOpensslCertGenerator } from "./ca-cert-openssl.ts";
import { createCertMinter, type CertMinter } from "./integration-cert-minter.ts";
import {
  createIntegrationMitmListener,
  type MitmListenerHandle,
} from "./integration-mitm-listener.ts";
import { createIntegrationEgressListener } from "./integration-egress-listener.ts";
import {
  createBrowserEgressGateway,
  type BrowserEgressGatewayHandle,
} from "./browser-egress-gateway.ts";
import {
  assertBrowserIsolationSlot,
  browserGatewayPort,
  isFirecrackerBrowserIsolation,
} from "./browser-guest-isolation.ts";
import {
  assertBrowserWorkerCompatible,
  selectBrowserProvider,
  type BrowserHandle,
  type BrowserProvider,
  type BrowserResourceProfile,
} from "./browser-provider.ts";
import {
  createIntegrationCredentialsSource,
  fetchInitialIntegrationCredentials,
  type IntegrationCredentialsSource,
} from "./integration-credentials-source.ts";
import { createApiCallCredentialAdapter } from "./api-call-credentials.ts";
import { runConnectLogin } from "./connect-login.ts";
import { browserSafeErrorCode, runBrowserConnect } from "./browser-connect.ts";
import {
  createApiCallToolDefs,
  isSyntheticApiToolName,
  type ApiCallIntegrationConfig,
  type ApiCallToolDeps,
} from "./mcp.ts";
import {
  selectIntegrationRuntimeAdapter,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type RuntimeEgressContext,
} from "./integration-runtime-adapter.ts";
// Side-effect imports — each adapter module registers itself on load.
// New adapters (firecracker, podman, …) plug in with one more import here.
import "./integration-runtime-adapter-docker.ts";
import "./integration-runtime-adapter-process.ts";
import "./browser-provider-docker.ts";
import "./browser-provider-process.ts";

const STANDARD_BROWSER_PROFILE: BrowserResourceProfile = {
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  shmBytes: 256 * 1024 * 1024,
  maxContexts: 1,
  maxPages: 4,
};

/**
 * Re-export the canonical spawn-spec type from `@appstrate/core/sidecar-types`
 * so adapter modules can import it from the same file that owns the rest of
 * the sidecar boot surface.
 */
export type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import type {
  IntegrationBootBreadcrumb,
  IntegrationBootReport,
} from "@appstrate/core/sidecar-types";
import type { WorkspaceHandle } from "@appstrate/core/platform-types";

/**
 * Decode the workspace handle from the launching orchestrator's
 * `WORKSPACE_HANDLE_JSON` env var. Returns `null` when the var is
 * absent or malformed — the sidecar then degrades to no-workspace
 * (any opt-in mcp-server runs without workspace access, logged as a
 * warning at spawn time). Strict shape validation: a foreign-shaped
 * JSON triggers a one-time warn but doesn't abort boot.
 */
/**
 * Reduce a URL to `host + path` for log surfaces — drops query string
 * (signed credentials commonly land there) and credentials in the
 * userinfo component. Falls back to "<unparseable>" when the value
 * isn't a parseable URL so a logging path never throws.
 */
function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

function decodeWorkspaceHandle(): WorkspaceHandle | null {
  const raw = process.env.WORKSPACE_HANDLE_JSON;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("WORKSPACE_HANDLE_JSON: failed to parse; degrading to no-workspace", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const handle = parsed as { kind?: unknown; name?: unknown; path?: unknown };
  if (handle.kind === "volume" && typeof handle.name === "string" && handle.name.length > 0) {
    return { kind: "volume", name: handle.name };
  }
  if (handle.kind === "directory" && typeof handle.path === "string" && handle.path.length > 0) {
    return { kind: "directory", path: handle.path };
  }
  logger.warn("WORKSPACE_HANDLE_JSON: unrecognised shape; degrading to no-workspace", {
    kind: typeof handle.kind === "string" ? handle.kind : "<missing>",
  });
  return null;
}

/**
 * Where the sidecar fetches integration bundles from. The platform
 * surface is `GET /internal/mcp-server-bundle/:scope/:name` with
 * Bearer-token auth (same run-token as the credentials endpoint).
 */
export interface BundleFetchOptions {
  platformApiUrl: string;
  runToken: string;
  /** Organization proxy selected for this run; browser gateways fail closed on it. */
  proxyUrl?: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Override for tests: DNS resolver used by the per-integration egress
   * listeners' SSRF rebind guard (tests use non-resolving mock hostnames).
   * Defaults to the system resolver.
   */
  resolveHostFn?: HostResolver;
}

export interface BootIntegrationsResult {
  host: McpHost;
  /**
   * Tools registered on `host`, ready to merge into the sidecar's MCP
   * surface. Includes spawned/remote integration tools AND the generic
   * `api_call` (+ optional `api_upload`) tools, which are now registered
   * as trusted in-process MCP servers on the same host — one pipeline.
   */
  tools: AppstrateToolDefinition[];
  /** Per-integration spawn outcome — useful for run-event observability. */
  spawned: Array<{
    integrationId: string;
    namespace: string;
    toolCount: number;
    /**
     * AFPS §7.1 build-provenance flag forwarded from
     * `IntegrationSpawnSpec.manifest.server.vendored`. Set only for local
     * sources whose mcp-server was vendored into the integration's own
     * bundle; omitted for remote/serverless integrations.
     */
    vendored?: boolean;
  }>;
  /** Per-integration failures — captured here; the agent aborts the run on any. */
  failed: Array<{ integrationId: string; error: string }>;
  /**
   * Structured boot report fetched by the agent via `GET /integrations/boot-report`.
   * Carries the ordered per-phase breadcrumbs (run-log observability) and the
   * `ok` flag that tells the agent whether to fail the run.
   */
  report: IntegrationBootReport;
  /** Idempotent teardown — closes every upstream MCP client + runtime adapter. */
  shutdown: () => Promise<void>;
}

/**
 * Parse the `INTEGRATIONS_TO_SPAWN_JSON` env var. Returns `null` when the
 * env var is missing or empty — the caller proceeds without integrations.
 */
export function readIntegrationSpecsFromEnv(env = process.env): IntegrationSpawnSpec[] | null {
  const raw = env.INTEGRATIONS_TO_SPAWN_JSON;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("INTEGRATIONS_TO_SPAWN_JSON is not valid JSON; skipping integrations", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!Array.isArray(parsed)) {
    logger.warn("INTEGRATIONS_TO_SPAWN_JSON must be an array; skipping integrations");
    return null;
  }
  return parsed.filter((s): s is IntegrationSpawnSpec => {
    return (
      typeof s === "object" &&
      s !== null &&
      typeof (s as IntegrationSpawnSpec).integrationId === "string" &&
      typeof (s as IntegrationSpawnSpec).namespace === "string" &&
      typeof (s as IntegrationSpawnSpec).manifest === "object"
    );
  });
}

/**
 * Fetch a referenced mcp-server package's bundle from the platform's internal
 * surface. AFPS: a local-source integration references a SEPARATE
 * mcp-server package (`source.server.name`); its bundle carries the runnable
 * server code. The endpoint authorises with the same Bearer run-token as the
 * credentials surface and verifies that the run's agent declares an installed
 * integration referencing this mcp-server.
 */
async function fetchBundleBytes(
  mcpServerId: string,
  serverVersion: string | undefined,
  opts: BundleFetchOptions,
): Promise<Uint8Array> {
  // #588 — when the platform pinned a concrete version at run kickoff, forward
  // it so the bytes match the manifest the spawn-resolver read. Absent → the
  // route serves the latest non-yanked version (back-compat).
  const url = serverVersion
    ? `${opts.platformApiUrl}/internal/mcp-server-bundle/${mcpServerId}?version=${encodeURIComponent(serverVersion)}`
    : `${opts.platformApiUrl}/internal/mcp-server-bundle/${mcpServerId}`;
  const f = opts.fetchFn ?? fetch;
  const res = await f(url, { headers: { Authorization: `Bearer ${opts.runToken}` } });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new Error(
      detail || `Failed to fetch mcp-server bundle for ${mcpServerId}: HTTP ${res.status}`,
    );
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Extract a ZIP bundle (already-bytes) to a fresh directory under
 * `os.tmpdir()`. Path traversal is defended in depth: every entry is
 * normalised + the resolved path must remain under the extraction root.
 *
 * Exported for unit testing the zip-slip write guard in isolation; production
 * callers reach it via {@link bootIntegrations}.
 */
export async function extractBundle(bytes: Uint8Array, namespace: string): Promise<string> {
  // Namespace is the integration package id (e.g. `@scope/name`). Both `@`
  // and `/` are illegal in a mkdtemp template under macOS/Linux — collapse
  // to a path-safe slug. The directory is private to this run anyway.
  const safe = namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const root = await mkdtemp(join(tmpdir(), `afps-integ-${safe}-`));
  // Memory-bounded streaming unzip: a hostile/oversized bundle can't OOM the
  // sidecar (decompression-bomb floor). Caps chosen for a realistic mcp-server
  // bundle (multi-MB code + deps) with generous headroom: 200 MiB total across
  // at most 10k entries. `unzipBounded` throws `DecompressionLimitError` on a
  // budget breach; it excludes directory entries but does NOT sanitize paths —
  // the per-entry zip-slip guard below is preserved verbatim.
  const files = unzipBounded(bytes, {
    maxDecompressedBytes: 200 * 1024 * 1024,
    maxFiles: 10_000,
  });
  for (const [rel, contents] of Object.entries(files)) {
    if (rel.endsWith("/")) continue;
    const relPosix = rel.split("\\").join("/");
    const dest = normalize(join(root, relPosix));
    if (!dest.startsWith(root + "/") && dest !== root) {
      throw new Error(`integrations-boot: refusing to write outside root: ${rel}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents);
  }
  return root;
}

/**
 * Phase 7 — connect to a remote Streamable HTTP MCP server using the
 * actor's live credentials. Auth-type-agnostic: reads the resolved
 * `HttpDeliveryPlan` per request from the credentials source so the same
 * code path handles OAuth2 (refresh-aware Bearer), api_key (static PAT
 * via `Authorization: Bearer …` or any configured header), basic, etc.
 *
 * Per-request flow:
 *   1. Read `source.snapshot().deliveryPlans[authKey]` — fresh after any
 *      refresh because the source replaces the whole payload in place.
 *   2. Inject `{ headerName: `${headerPrefix}${value}` }` on the outbound.
 *   3. On 401, call `refreshOnUnauthorized(authKey)` (no-op for static
 *      credentials — the source's per-authKey cooldown protects the
 *      platform endpoint from refresh storms) and retry once.
 *
 * Auth selection: in practice the credentials payload carries EXACTLY ONE
 * auth — the platform's 5-layer connection cascade resolves a single
 * `integration_connections` row per run, and the resolver returns only that
 * row's auth (see `integration-credentials-resolver.ts`, asserted by its
 * `auths.length === 1` test). So this is a trivial pick, not a second policy
 * site: the oauth2-first / first-with-a-plan ordering is just a defensive
 * tie-breaker should the payload ever surface more than one. Throws when no
 * auth produces an injectable header — Phase 7 can't run an MCP client
 * without authentication (every public hosted MCP today gates `tools/call`
 * behind some credential).
 */
/**
 * Dependency seam for {@link connectRemoteHttpIntegration} — production
 * callers omit it (the default wires the real Streamable HTTP client). The
 * credentials source is no longer a dep: the caller hoists ONE source per
 * integration and passes it in directly, so tests inject a fake source as the
 * second positional argument instead. Unit tests still override `createClient`
 * / `createSseClient` to exercise the per-request Bearer injection +
 * 401-refresh-retry closure without standing up a real MCP server. See
 * CLAUDE.md "Mocking Policy".
 */
export interface ConnectRemoteHttpDeps {
  createClient?: typeof createMcpHttpClient;
  /**
   * Optional override for the SSE transport path (AFPS §7.1
   * `source.remote.transport: "sse"`). Production callers omit it — the
   * default wires `SSEClientTransport` from `@modelcontextprotocol/sdk`.
   * Tests inject a stub to exercise the SSE branch without binding a
   * real EventSource.
   */
  createSseClient?: (
    url: string,
    opts: {
      fetch: typeof fetch;
      clientInfo: { name: string; version: string };
    },
  ) => Promise<AppstrateMcpClient>;
  /**
   * Optional DNS resolver forwarded to the SSRF guard (`guardedFetch`'s
   * `resolve` option) — same seam as `credential-proxy.ts`'s
   * `deps.resolveHost`. Tests inject a resolver returning a public address
   * so fixture hostnames pass the guard without real DNS; production
   * callers omit it (system resolver). The guard itself ALWAYS runs —
   * injecting a transport factory does NOT disable it.
   */
  resolveHost?: HostResolver;
}

/**
 * Default SSE client builder — wires `SSEClientTransport` from the MCP SDK
 * with our `customFetch` (per-request Bearer + 401-retry). The SDK's SSE
 * transport accepts a `fetch` override under `eventSourceInit` for the
 * stream and `requestInit` for outbound POSTs; we route both through the
 * same custom fetch so credential headers are injected on every hop.
 *
 * AFPS §7.1 — `"sse"` is the SDK's deprecated-but-supported legacy
 * transport, kept here for manifests targeting older remote MCP servers
 * (some hosted MCP providers still default to SSE).
 */
async function defaultCreateSseClient(
  url: string,
  opts: {
    fetch: typeof fetch;
    clientInfo: { name: string; version: string };
  },
): Promise<AppstrateMcpClient> {
  const targetUrl = new URL(url);
  const transport = new SSEClientTransport(targetUrl, {
    // The SDK's SSEClientTransport accepts a `fetch` override applied to
    // both the initial GET (stream open) and the outbound POSTs (client→
    // server JSON-RPC messages). Routing through customFetch attaches the
    // Bearer header per-request and triggers the 401-refresh-and-retry
    // closure consistently across both directions.
    fetch: opts.fetch as never,
  });
  const client = new Client(opts.clientInfo);
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }
  return wrapClient(client, transport, toolTimeoutMsFromEnv());
}

export async function connectRemoteHttpIntegration(
  spec: IntegrationSpawnSpec,
  source: IntegrationCredentialsSource,
  deps: ConnectRemoteHttpDeps = {},
): Promise<{ client: AppstrateMcpClient; authKey: string }> {
  const createClient = deps.createClient ?? createMcpHttpClient;
  const createSseClient = deps.createSseClient ?? defaultCreateSseClient;

  const serverUrl = spec.manifest.server?.url;
  if (!serverUrl) {
    throw new Error(
      `integration ${spec.integrationId} declares sourceKind="remote" but no server.url`,
    );
  }
  // AFPS §7.1 — pick the MCP client transport from the manifest.
  // Default to `streamable-http` when the field is absent (back-compat
  // for manifests that predated the enum). Anything else is a
  // hard-fail at boot — the platform validates the enum at install time,
  // so reaching this branch means the manifest carries a value the
  // sidecar doesn't (yet) know how to dispatch to.
  const declaredTransport = spec.manifest.server?.transport;
  const transport: "streamable-http" | "sse" =
    declaredTransport === "sse" ? "sse" : "streamable-http";
  if (
    declaredTransport !== undefined &&
    declaredTransport !== "streamable-http" &&
    declaredTransport !== "sse"
  ) {
    throw new Error(
      `integration ${spec.integrationId} declares unsupported source.remote.transport="${declaredTransport}" (allowed: "streamable-http" | "sse")`,
    );
  }

  // Read the hoisted source's current payload for auth-selection. The source
  // was created (and its initial credentials fetched) once by the caller.
  const initial = source.snapshot();

  // Pick the auth whose header we'll inject. The payload normally carries a
  // SINGLE auth (the cascade-resolved connection), so this resolves to that
  // one auth — NOT a policy decision. OAuth2-first / first-with-a-plan is only
  // a defensive tie-breaker if the payload ever surfaces more than one. The
  // credentials resolver populates `deliveryPlans[authKey]` for every auth
  // declaring `delivery.http` — including `{}` (empty), which defaults per
  // `AUTH_TYPE_HTTP_DEFAULTS` (oauth2 → Bearer, api_key → X-Api-Key, …).
  const oauthAuth = initial.auths.find(
    (a) => a.authType === "oauth2" && initial.deliveryPlans[a.authKey],
  );
  const fallbackAuth = oauthAuth
    ? null
    : initial.auths.find((a) => initial.deliveryPlans[a.authKey]);
  const pickedAuth = oauthAuth ?? fallbackAuth;
  if (!pickedAuth) {
    throw new Error(
      `integration ${spec.integrationId} (sourceKind="remote") has no auth with a resolvable delivery.http plan`,
    );
  }
  const authKey = pickedAuth.authKey;

  // Per-request header reader. Reading from the snapshot on every call
  // means an OAuth refresh (which swaps `payload` in place) is picked up
  // automatically — no MCP transport restart needed. Static creds
  // (api_key) just return the same value forever.
  const readHeader = (): { name: string; value: string } | null => {
    const plan = source.snapshot().deliveryPlans[authKey];
    if (!plan) return null;
    return { name: plan.headerName, value: `${plan.headerPrefix}${plan.value}` };
  };

  // SSRF-guard the egress — ALWAYS (P0-2): `guardedFetch` does per-hop DNS
  // re-checking, manual redirect following, drops credential headers on
  // cross-origin redirects and strips userinfo — throwing `SsrfBlockedError`
  // on private/loopback/link-local hosts. This is the only otherwise-
  // unguarded sidecar egress path (the MITM/CONNECT listeners already
  // resolve+check). The guard sits INSIDE the credential closure so the
  // Bearer is injected exactly once on the original request and
  // `guardedFetch` owns the redirect hops (re-injecting per hop would leak
  // the credential cross-origin). Tests never disable the guard — they
  // inject `deps.resolveHost` (a resolver returning a public address for
  // fixture hostnames) so the guard code on this path is identical for
  // every caller; `guardedFetch` reads the live global `fetch`, which the
  // tests stub.

  // `typeof fetch` (Bun) carries a static `preconnect` member alongside the
  // call signature. The MCP transport's `fetch?: typeof fetch` option demands
  // the full shape, so forward the real `preconnect` rather than casting it
  // away — the override stays a faithful drop-in for `fetch`.
  const customFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const send = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);
        const h = readHeader();
        if (h) headers.set(h.name, h.value);
        // `guardedFetch` accepts `string | URL`; the MCP transports always
        // call with a URL/string target (headers/body ride in `init`), so a
        // stray `Request` is normalised to its URL for the type.
        const target: string | URL =
          typeof input === "string" || input instanceof URL ? input : input.url;
        // Operator-trusted internal hosts (EGRESS_ALLOW_INTERNAL_HOSTS, forwarded
        // by the platform) skip only the host blocklist — without this, a remote
        // MCP server the platform-side spawn validation just allowed (internal
        // host explicitly allowlisted by the operator) would be re-blocked here
        // and fail opaquely in-run. Redirect discipline still applies.
        return guardedFetch(
          target,
          { ...init, headers },
          {
            allowHost: isOperatorTrustedEgressHost,
            // The injected credential header is arbitrarily NAMED by the
            // manifest's delivery plan (e.g. `X-Api-Key`), so guardedFetch's
            // builtin authorization/cookie strip set cannot know about it —
            // declare it, or a hostile server 302ing cross-origin would carry
            // the credential to another origin.
            ...(h ? { sensitiveHeaders: [h.name] } : {}),
            ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
          },
        );
      };
      let res = await send();
      if (res.status === 401 && source.refreshOnUnauthorized) {
        const refreshed = await source.refreshOnUnauthorized(authKey).catch(() => false);
        if (refreshed) res = await send();
      }
      return res;
    },
    { preconnect: fetch.preconnect },
  );

  const clientInfo = {
    name: "appstrate-sidecar-remote-integration",
    version: "0.1.0",
  };
  // AFPS §7.1 — dispatch on the manifest's declared transport. Both
  // branches share the same per-request Bearer + 401-retry closure
  // (`customFetch` above), so credential injection + refresh semantics
  // are identical across Streamable HTTP and SSE.
  const toolTimeoutMs = toolTimeoutMsFromEnv();
  const client =
    transport === "sse"
      ? await createSseClient(serverUrl, { fetch: customFetch, clientInfo })
      : await createClient(serverUrl, {
          fetch: customFetch,
          clientInfo,
          retry: { deadlineMs: 30_000 },
          ...(toolTimeoutMs !== undefined ? { defaultTimeoutMs: toolTimeoutMs } : {}),
        });
  return { client, authKey };
}

/**
 * P2 — mint a `connect.tool` + `runAt: "run-start"` session at boot.
 *
 * Called after the integration's MCP client connected, its MITM source was
 * created, and `host.register(...)` ran. Drives `runConnectLogin` against the
 * integration's `login` tool with the decrypted login secret substituted
 * proxy-side. On success, the source now injects the captured session header
 * for the rest of the run.
 *
 * Throws when `spec.connectLogin` is set but no MITM source exists (CA
 * bring-up failed, or the spawn resolver didn't emit `httpDeliveryAuths`) or
 * when the login tool itself fails — the caller maps the throw onto the boot
 * result's `failed[]` list. Exported for unit testing; production callers go
 * through {@link bootIntegrations}.
 *
 * `allocatedNamespace` is the value {@link McpHost.register} returned for this
 * integration — the host may have disambiguated `spec.namespace` with a
 * suffix, and {@link McpHost.getUpstreamClient} keys against the allocated
 * form.
 */
export async function runConnectLoginHook(
  spec: IntegrationSpawnSpec,
  host: McpHost,
  mitmSource: IntegrationCredentialsSource | null,
  allocatedNamespace: string,
): Promise<void> {
  const cl = spec.connectLogin;
  if (!cl) return;
  if (!mitmSource) {
    throw new Error(
      "connect-login requires the integration's MITM credentials source, but none was created (CA bring-up may have failed)",
    );
  }
  // Same opts drive the initial login AND every mid-run re-login. The
  // namespace MUST be the ALLOCATED one (McpHost may have suffixed it) so the
  // re-login closure resolves the same upstream client.
  const loginOpts = {
    host,
    namespace: allocatedNamespace,
    toolName: cl.toolName,
    ...(cl.produces ? { produces: cl.produces } : {}),
    inputs: cl.inputs,
    source: mitmSource,
    authKey: cl.authKey,
    authType: cl.authType,
    authorizedUris: cl.authorizedUris,
    deliveryHttp: cl.deliveryHttp,
  };
  await runConnectLogin(loginOpts);
  logger.info("integration connect-login session minted", {
    integrationId: spec.integrationId,
    namespace: spec.namespace,
    authKey: cl.authKey,
  });
  // P3 — register the mid-run re-login handler. When an upstream returns one
  // of `reauthOn` (default `[401]`) for a request using this session, the MITM
  // listener calls `source.refreshOnUnauthorized(authKey)`, which routes to
  // this handler (a fresh `runConnectLogin`) and retries the request once.
  // A failed re-login resolves `false`, so the listener leaves the original
  // failed upstream response untouched (no retry, no loop).
  //
  // CONCURRENCY REQUIREMENT: re-login calls the integration's `login` tool on
  // the SAME MCP server that is mid-flight serving the data-tool call that
  // triggered the reauth. A server that processes JSON-RPC strictly serially
  // (e.g. a naive `for line in stdin` loop) deadlocks — it cannot read the
  // `login` request until the parked data call returns, but that call is
  // blocked waiting on this very re-login. Real MCP-SDK servers handle
  // concurrent requests and are unaffected; hand-rolled stdio servers that
  // declare `reauthOn` MUST serve requests concurrently.
  mitmSource.setReloginHandler(
    cl.authKey,
    () =>
      runConnectLogin(loginOpts)
        .then(() => true)
        .catch(() => false),
    cl.reauthOn ?? [401],
  );
}

/**
 * Per-run CA materials shared by every MITM listener in a run: one CA per run,
 * N listeners share the minter (which lazily mints per-SNI leaf certs). The CA
 * cert PEM is materialised on local fs (mode 0444) so the runtime adapter can
 * ferry it into each runner's trust store; the private key never leaves memory.
 */
interface RunCaMaterials {
  bundle: CaBundle;
  minter: CertMinter;
  /** Local-fs path to the CA cert PEM. Unlinked by the caller at teardown. */
  certHostPath: string;
}

/**
 * Mint a per-run CA + cert minter and materialise the cert PEM on local fs.
 * Shared by the agent-run path ({@link bootIntegrations}) and the ephemeral
 * connect-run ({@link runConnectOnce}). The caller owns error handling:
 * `bootIntegrations` degrades to env-delivery-only on failure, `runConnectOnce`
 * lets the throw abort the connect.
 */
async function prepareRunCa(runId: string, dirPrefix: string): Promise<RunCaMaterials> {
  const bundle = await planCaBundle({
    runId,
    // /run is tmpfs on the sidecar image. The planner ONLY uses tmpfsRoot for
    // derived path strings inside the CaBundle return value — it doesn't write
    // anything itself. We materialise the CA cert below at our own location.
    tmpfsRoot: "/run/afps",
    notAfterSeconds: 3600,
    generator: createOpensslCertGenerator(),
  });
  const caDir = await mkdtemp(join(tmpdir(), dirPrefix));
  const certHostPath = join(caDir, "ca.pem");
  await writeFile(certHostPath, bundle.pems.caCertPem, { mode: 0o444 });
  const minter = createCertMinter({
    caCertPem: bundle.pems.caCertPem,
    caKeyPem: bundle.pems.caKeyPem,
  });
  return { bundle, minter, certHostPath };
}

async function disposeRunCa(ca: RunCaMaterials): Promise<void> {
  await rm(ca.certHostPath, { force: true }).catch(() => {});
  await ca.minter.dispose().catch(() => {});
}

interface SpawnAndConnectResult {
  /** The wrapped MCP client (already registered + pushed onto `clients`). */
  wrapped: AppstrateMcpClient;
  /** Namespace the host actually allocated (may be a disambiguated suffix). */
  allocatedNs: string;
  /** The MITM credentials source when a listener was created, else null. */
  mitmSource: IntegrationCredentialsSource | null;
  /** Tools added to the host by this registration. */
  toolCount: number;
  /** Adapter diagnostic id (e.g. container id), when the adapter reports one. */
  diagnosticId?: string;
  /** Wall-clock ms spent in `adapter.spawn` (process fork / `docker create`+`cp`+`start`). */
  spawnMs: number;
  /** Wall-clock ms spent on the MCP `initialize` handshake. */
  connectMs: number;
}

/**
 * The SINGLE spawn→connect→register pipeline for a local (node|python|binary)
 * integration MCP server. Used identically by the agent-run path
 * ({@link bootIntegrations}) and the ephemeral connect-run
 * ({@link runConnectOnce}); they diverge only in what they do AFTER (keep the
 * session alive for the agent vs. run the login tool once + tear down).
 *
 * Steps: optional per-integration MITM listener (when `wantsMitm` && a CA is
 * available) → fetch + extract the bundle → `adapter.spawn` → open the MCP
 * client with a 30s connect race → `host.register`.
 *
 * Resources are pushed onto the caller-owned `clients` / `mitmListeners`
 * collectors AS they are created, so a throw mid-pipeline still lets the
 * caller's teardown reclaim a half-built listener/client (no leak on error).
 */
/** Max runner-stderr lines retained per integration for failure reports (#779). */
const STDERR_TAIL_MAX_LINES = 20;
/** Cap per stderr line folded into a failure report — avoids a runaway blob. */
const STDERR_LINE_MAX_CHARS = 500;

/**
 * Best-effort secret scrub for a runner stderr line before it is folded
 * into a run's failure report (#779). Runner stderr already flows to the
 * sidecar's own logs; surfacing it in the run report widens the audience
 * to the operator who triggered the run, so scrub the high-signal
 * credential shapes a third-party server might print on a failed auth
 * (bearer tokens, provider key prefixes, JWTs, `key=`/`token=` values).
 * This is defence-in-depth, not a guarantee — the primary control remains
 * that runs are org-scoped to an actor who already holds the integration's
 * credentials.
 */
export function scrubStderrLine(line: string): string {
  return (
    line
      .slice(0, STDERR_LINE_MAX_CHARS)
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]")
      // Separator-prefixed families (`sk-…`, `ghp_…`, `xoxb-…`) keep the
      // mandatory `-`/`_` so prose words starting with `sk`/`pk` survive;
      // AWS access-key ids (`AKIA` + 16 upper-alnum, no separator) and Google
      // OAuth tokens (`ya29.` + dot) get their own literal shapes.
      .replace(/\b(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9._-]{6,}/g, "[redacted-key]")
      .replace(/\bAKIA[A-Z0-9]{12,}/g, "[redacted-key]")
      .replace(/\bya29\.[A-Za-z0-9._-]{6,}/g, "[redacted-key]")
      .replace(
        /\b(token|secret|password|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)(["'\s:=]+)[^\s"',&]+/gi,
        "$1$2[redacted]",
      )
  );
}

/**
 * Browser drivers can hold a CDP bearer token and, for connection acquisition,
 * bootstrap secrets. Their stderr is therefore a secret-bearing channel, not
 * an operator diagnostic stream. Suppress it wholesale instead of relying on
 * pattern redaction that cannot recognize arbitrary passwords or page data.
 */
export function shouldSuppressIntegrationStderr(
  spec: Pick<IntegrationSpawnSpec, "browser">,
): boolean {
  return spec.browser !== undefined;
}

/**
 * Operator override for the per-call MCP tool timeout applied to
 * integration clients (#779 annex). Absent/invalid → `undefined` → the
 * MCP SDK default applies, unchanged behaviour. Third-party servers that
 * do a cold OAuth refresh on their first tool call can legitimately need
 * more; mirrors the `APPSTRATE_MCP_CONNECT_DEADLINE_MS` operator knob.
 */
export function toolTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.APPSTRATE_MCP_TOOL_TIMEOUT_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

async function spawnAndConnectLocalIntegration(params: {
  spec: IntegrationSpawnSpec;
  runId: string;
  adapter: IntegrationRuntimeAdapter;
  adapterCtx: RuntimeAdapterRunContext;
  host: McpHost;
  bundleFetchOpts: BundleFetchOptions;
  /**
   * The integration's single shared credentials Source, hoisted by the caller
   * ({@link bootIntegrations} / {@link runConnectOnce}). The MITM listener
   * reads/refreshes through it; the SAME instance is also handed to the
   * connect-login hook + the api_call adapter so a run-start session is
   * visible everywhere. `null` only when the integration needs no source
   * (no MITM, no api_call) — then no listener is mounted.
   */
  source: IntegrationCredentialsSource | null;
  /** Per-run CA materials; null disables MITM (env-delivery-only path). */
  ca: RunCaMaterials | null;
  /**
   * Per-run shared workspace handle decoded from the sidecar's
   * `WORKSPACE_HANDLE_JSON` env var (set by the platform orchestrator).
   * Passed verbatim to `adapter.spawn`; the adapter wires it into the
   * runner only when the spec's `workspaceMount` is also set (opt-in
   * by the referenced mcp-server's `_meta["dev.appstrate/workspace"]`).
   */
  workspaceHandle: WorkspaceHandle | null;
  /** Front this integration with a MITM listener (also needs `ca` + `source`). */
  wantsMitm: boolean;
  /**
   * Issue #543 — the runner needs a controlled egress route but no header
   * injection (a `delivery.env` auth declaring an outbound surface). When set
   * and `wantsMitm` is false, mount a plain CONNECT egress listener. MITM
   * wins when both are set (it already provides egress).
   */
  wantsEgress: boolean;
  browser?: BrowserHandle;
  /** Allowlist for `host.register`. `[]` exposes nothing (connect-run). */
  allowedTools: readonly string[] | undefined;
  /**
   * R8a defensive filter — `manifest.hidden_tools` echoed back from the
   * platform via `IntegrationSpawnSpec.hiddenTools`. The host applies it
   * after the allowlist to defend against fixtures / direct DB writes
   * that bypass install-time catalog resolution. `undefined` / empty =
   * no extra filtering.
   */
  hiddenTools?: readonly string[];
  /** Log-message prefix: `"integration"` (agent-run) | `"connect-run"`. */
  logLabel: string;
  /** Caller-owned teardown collectors — appended to as resources are built. */
  clients: AppstrateMcpClient[];
  mitmListeners: MitmListenerHandle[];
  /**
   * Caller-owned bounded tail of the runner's stderr lines (#779). The
   * spawn pipeline pushes every line (capped at
   * {@link STDERR_TAIL_MAX_LINES}); on failure the caller folds the tail
   * into the recorded error so the actual cause (an OAuth 405, a module
   * crash, …) reaches the run report instead of living only in
   * `docker logs` on the sidecar host.
   */
  stderrTail?: string[];
}): Promise<SpawnAndConnectResult> {
  const { spec, runId, adapter, adapterCtx, host, bundleFetchOpts, ca, logLabel } = params;

  // One listener per integration, picked MITM-first (#543). `egressCtx` is
  // handed to the adapter as the runner's HTTPS_PROXY:
  //   - MITM listener   → caCertHostPath set (TLS terminate + inject).
  //   - plain CONNECT    → caCertHostPath null (tunnel + SSRF floor only).
  //   - neither          → null (mtls / delivery.files reach upstream directly).
  let egressCtx: RuntimeEgressContext | null = null;
  // The MITM listener is mounted only when this integration wants MITM, a CA
  // came up, AND the caller hoisted a source. When mounted, the shared
  // `source` is what the connect-login hook drives — surfaced back to the
  // caller as `mitmSource` (kept null when no listener exists, so the hook's
  // "MITM required" guard still fires on a CA-bring-up failure).
  let mitmMounted = false;
  if (params.wantsMitm && ca !== null && params.source !== null) {
    const source = params.source;
    const listener = createIntegrationMitmListener({
      caBundle: ca.bundle,
      minter: ca.minter,
      credentials: source,
      // Adapter decides where the listener binds so the runner can reach it
      // (0.0.0.0 for bridged networks, 127.0.0.1 when it shares the parent NS).
      host: adapterCtx.listenerBindHost,
      resolveHostFn: bundleFetchOpts.resolveHostFn,
      onEvent: (event) => {
        // Surface enough to debug auth-injection bugs without leaking
        // signed query params. URL is reduced to `host + path` (no
        // query); `headerInjected` (bool only — never the value) tells
        // operators a missing-auth scenario apart from an upstream
        // 401 in one glance.
        const safe = (() => {
          if (event.kind === "request-forwarded") {
            const u = safeUrlForLog(event.url);
            return {
              kind: event.kind,
              method: event.method,
              url: u,
              status: event.status,
              authKey: event.authKey,
              headerInjected: event.headerInjected,
              retried: event.retried,
            };
          }
          if (event.kind === "request-refused" || event.kind === "upstream-error") {
            return { ...event, url: safeUrlForLog(event.url) };
          }
          return event;
        })();
        logger.info(`${logLabel} mitm event`, { integrationId: spec.integrationId, ...safe });
      },
    });
    await listener.ready;
    params.mitmListeners.push(listener);
    mitmMounted = true;
    const port = listener.address().port;
    egressCtx = { proxyUrl: adapterCtx.proxyUrlFor(port), caCertHostPath: ca.certHostPath };
    logger.info(`${logLabel} MITM listener ready`, {
      integrationId: spec.integrationId,
      localUrl: listener.proxyUrl(),
      runnerProxyUrl: egressCtx.proxyUrl,
    });
  } else if (params.wantsEgress) {
    // No injection plan, but the runner declares an outbound surface — give it
    // a plain CONNECT egress route (tunnel + SSRF floor, NO TLS termination,
    // NO cert mint). `caCertHostPath: null` tells the adapter to skip the CA
    // env block + cert delivery.
    const listener = createIntegrationEgressListener({
      host: adapterCtx.listenerBindHost,
      resolveHostFn: bundleFetchOpts.resolveHostFn,
      onEvent: (event) =>
        logger.info(`${logLabel} egress event`, { integrationId: spec.integrationId, ...event }),
    });
    await listener.ready;
    params.mitmListeners.push(listener);
    const port = listener.address().port;
    egressCtx = { proxyUrl: adapterCtx.proxyUrlFor(port), caCertHostPath: null };
    logger.info(`${logLabel} egress listener ready`, {
      integrationId: spec.integrationId,
      localUrl: listener.proxyUrl(),
      runnerProxyUrl: egressCtx.proxyUrl,
    });
  }

  // AFPS — fetch the referenced mcp-server package's bundle (the runnable
  // server code), NOT the integration's own bundle. Local-source integrations
  // always carry `server.packageId`; fall back to the integration id only
  // if a spec somehow omits it (defensive).
  const serverPackageId = spec.manifest.server?.packageId ?? spec.integrationId;
  const bytes = await fetchBundleBytes(
    serverPackageId,
    spec.manifest.server?.version,
    bundleFetchOpts,
  );
  const root = await extractBundle(bytes, spec.namespace);

  const spawnStart = performance.now();
  const suppressStderr = shouldSuppressIntegrationStderr(spec);
  let suppressedStderrObserved = false;
  const spawnedIntegration = await adapter.spawn({
    runId,
    spec,
    bundleRoot: root,
    egress: egressCtx,
    ...(params.browser && spec.browser?.purpose === "automation"
      ? {
          browser: {
            endpoint: params.browser.endpoint,
            authToken: params.browser.authToken,
            protocolVersion: params.browser.protocolVersion,
          },
        }
      : {}),
    workspaceHandle: params.workspaceHandle,
    onStderrLine: (line) => {
      if (suppressStderr) {
        if (!suppressedStderrObserved) {
          suppressedStderrObserved = true;
          logger.info(`${logLabel} browser integration stderr suppressed`, {
            integrationId: spec.integrationId,
          });
        }
        return;
      }
      logger.info(`${logLabel} integration stderr`, { integrationId: spec.integrationId, line });
      if (params.stderrTail) {
        params.stderrTail.push(scrubStderrLine(line));
        if (params.stderrTail.length > STDERR_TAIL_MAX_LINES) params.stderrTail.shift();
      }
    },
  });

  const spawnMs = performance.now() - spawnStart;

  const connectStart = performance.now();
  const client = new Client(
    { name: "appstrate-sidecar-integration-host", version: "0.1.0" },
    // Advertise MCP Roots capability when the spec declares a workspace
    // mount and the launching orchestrator carried a handle. The server
    // (mcp-server runner) can then call roots/list to discover the
    // shared workspace root and bound its filesystem operations to it.
    // SOTA-consistent: cyanheads/git-mcp-server, modelcontextprotocol/
    // servers/filesystem all rely on the Roots protocol for boundary
    // discovery instead of trusting CWD or hardcoded paths.
    //
    // `listChanged: false` is deliberate: the workspace boundary is
    // static for the lifetime of a run — the orchestrator mounts a
    // single per-run volume at boot and never reconfigures it. Setting
    // `true` would force every Roots-aware server to subscribe to a
    // notification channel that will never fire. If multi-root or
    // dynamic remounting ever lands, flip this to `true` and emit
    // `notifications/roots/list_changed` from the mount-change path.
    spec.workspaceMount && params.workspaceHandle
      ? { capabilities: { roots: { listChanged: false } } }
      : undefined,
  );
  if (spec.workspaceMount && params.workspaceHandle) {
    const rootUri = `file://${spec.workspaceMount.mount}`;
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [
        {
          uri: rootUri,
          name: "workspace",
          _meta: {
            "dev.appstrate/workspace": {
              access: spec.workspaceMount!.access,
            },
          },
        },
      ],
    }));
  }
  const connectPromise = client.connect(spawnedIntegration.transport);
  // If the timeout wins the race, `connectPromise` is orphaned and may reject
  // later (once the hung transport finally errors) — attach a no-op catch so
  // that late rejection never surfaces as an unhandledRejection.
  connectPromise.catch(() => {});
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("MCP connect timeout (30s)")), 30_000);
    timeoutId.unref?.();
  });
  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } catch (err) {
    // Connect failed or timed out: reclaim the just-spawned runtime by closing
    // its transport (the adapter's subprocess/container exits with it) so a
    // hung MCP server doesn't leak a runtime for the whole run. Best-effort —
    // the original error is what the caller must see.
    await spawnedIntegration.transport.close().catch(() => {});
    throw err;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  const connectMs = performance.now() - connectStart;
  const wrapped = wrapClient(client, spawnedIntegration.transport, toolTimeoutMsFromEnv());
  params.clients.push(wrapped);

  const sizeBefore = host.size();
  const allocatedNs = await host.register({
    namespace: spec.namespace,
    client: wrapped,
    // Niveau 2 Phase 3 — McpHost.register filters `tools/list` to the agent's
    // declared tools. `undefined` keeps the legacy "all tools allowed".
    ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
    // R8a — apply `hidden_tools` belt-and-suspenders filter so a tool name
    // the manifest hides is never reachable, even via fixtures that bypassed
    // install-time catalog resolution.
    ...((params.hiddenTools?.length ?? 0) > 0 ? { hiddenTools: params.hiddenTools } : {}),
  });
  const toolCount = host.size() - sizeBefore;

  return {
    wrapped,
    allocatedNs,
    mitmSource: mitmMounted ? params.source : null,
    toolCount,
    spawnMs,
    connectMs,
    ...(spawnedIntegration.diagnosticId ? { diagnosticId: spawnedIntegration.diagnosticId } : {}),
  };
}

/**
 * No-silent-degradation guard: the agent author selected `spec.toolAllowlist`
 * tools, but only `added` of the server's native tools survived registration
 * (a selected tool can vanish if the server doesn't advertise it under the
 * declared name, or if the poisoning sanitiser drops its descriptor for being
 * too large). `added` counts ONLY the spawned/remote server's tools — never the
 * in-process `api_call`/`api_upload` tools, which are registered separately.
 * Those synthetic names ARE part of `spec.toolAllowlist` (the agent selects
 * them like any other tool), so they must be discounted from the requested set
 * before comparing — otherwise every agent that selects `api_call` alongside a
 * native tool gets a spurious "1 selected tool unavailable" warning.
 * Surface the shortfall as a `warn` breadcrumb so it reaches the boot report
 * and run logs instead of the LLM silently behaving as if the tool was never
 * authorised. Non-fatal by design: an optional tool that the upstream dropped
 * shouldn't abort an otherwise-healthy run.
 */
export function pushUnavailableToolBreadcrumb(
  spec: IntegrationSpawnSpec,
  added: number,
  breadcrumbs: IntegrationBootBreadcrumb[],
): void {
  const requested = (spec.toolAllowlist ?? []).filter((t) => !isSyntheticApiToolName(t));
  if (requested.length === 0 || added >= requested.length) return;
  const missing = requested.length - added;
  breadcrumbs.push({
    message: `${spec.integrationId}: ${missing}/${requested.length} selected tool(s) unavailable`,
    level: "warn",
    data: {
      integrationId: spec.integrationId,
      requested: requested.length,
      surviving: added,
      missing,
    },
  });
}

/**
 * Names hidden only from an integration's native MCP upstream. When a selected
 * api capability is attached as a trusted in-process tool, its canonical
 * name is reserved for that synthetic descriptor; otherwise a same-named
 * native tool would take the name first and force the trusted tool onto an
 * unselectable `_2` suffix. Manifest hidden_tools remain part of the set.
 */
export function hiddenToolsForNativeUpstream(
  spec: IntegrationSpawnSpec,
): readonly string[] | undefined {
  const hidden = new Set(spec.hiddenTools ?? []);
  for (const apiCall of spec.apiCalls ?? []) {
    hidden.add(apiCall.toolName);
    const legacyCallName =
      apiCall.toolName === "api_call" ? "api_call" : `api_call__${apiCall.authKey}`;
    hidden.add(legacyCallName);
    if ((apiCall.uploadProtocols?.length ?? 0) > 0) {
      hidden.add(apiCall.toolName.replace(/^api_call/, "api_upload"));
      hidden.add(legacyCallName.replace(/^api_call/, "api_upload"));
    }
  }
  return hidden.size > 0 ? [...hidden] : undefined;
}

/**
 * Breadcrumb for the serverless (`sourceKind: "none"`) branch, where the
 * in-process `api_call` server is the integration's entire surface.
 *
 * When `toolCount === 0` the integration is effectively non-functional: the
 * config (`integrations_configuration[id].tools`) didn't list `"api_call"`, so
 * the resolver filtered everything and nothing is callable. The agent silently
 * falls back to read/bash and the run looks healthy until it fails its job.
 * Emit a `warn` with an actionable message instead of a success-toned "ready"
 * breadcrumb, so the misconfiguration is self-diagnosing. Keep the
 * `ready (N tools)` wording only for `N > 0`.
 */
export function pushServerlessReadyBreadcrumb(
  spec: IntegrationSpawnSpec,
  toolCount: number,
  durationMs: number,
  breadcrumbs: IntegrationBootBreadcrumb[],
): void {
  if (toolCount === 0) {
    breadcrumbs.push({
      message: `${spec.integrationId}: api_call exposed 0 tools — nothing callable. Check integrations_configuration["${spec.integrationId}"].tools (a serverless integration must list "api_call").`,
      level: "warn",
      data: {
        integrationId: spec.integrationId,
        kind: "serverless",
        durationMs,
        toolCount: 0,
      },
    });
    return;
  }
  breadcrumbs.push({
    message: `${spec.integrationId}: api_call ready (${durationMs}ms, ${toolCount} tool${toolCount === 1 ? "" : "s"})`,
    level: "info",
    data: {
      integrationId: spec.integrationId,
      kind: "serverless",
      durationMs,
      toolCount,
    },
  });
}

/**
 * Spawn each integration sequentially, register the surviving ones on a
 * shared {@link McpHost}, and return the materialised tool list. Per-integration
 * failures are captured in `result.failed` so a single broken integration
 * doesn't black-hole the entire run. The one fatal exception is runtime
 * adapter selection (no adapter → nothing can spawn): that rethrows.
 */
export async function bootIntegrations(
  specs: IntegrationSpawnSpec[],
  bundleFetchOpts: BundleFetchOptions,
  /**
   * Credential-proxy core deps for the generic `api_call` tool. Built once
   * per run by `server.ts` and shared with `createApp` (same blob store).
   * When omitted (tests / api_call-less runs) the in-process api_call
   * server is skipped — a spec that declares `apiCall` is logged + dropped.
   */
  apiCallDeps?: ApiCallToolDeps,
): Promise<BootIntegrationsResult> {
  const host = new McpHost({
    onLog: (event) =>
      logger.info("integration host event", {
        source: event.source,
        level: event.level,
        data: event.data,
      }),
  });
  const spawned: BootIntegrationsResult["spawned"] = [];
  const failed: BootIntegrationsResult["failed"] = [];
  const breadcrumbs: IntegrationBootBreadcrumb[] = [];
  const clients: AppstrateMcpClient[] = [];
  const mitmListeners: MitmListenerHandle[] = [];
  const browserResources: Array<{
    handle: BrowserHandle;
    gateway: BrowserEgressGatewayHandle;
  }> = [];

  // The sidecar receives RUN_TOKEN but not always RUN_ID directly — we
  // need a stable identifier for labelling integration containers
  // (lets the orphan reaper match containers back to their run if the
  // sidecar dies mid-shutdown). NEVER derive this from RUN_TOKEN: even
  // a 12-char slice of the signed token would leak ~72 bits of secret
  // entropy via `docker inspect` (labels are visible to anyone who can
  // talk to the daemon). Fall back to an opaque random id when RUN_ID
  // isn't available — orphan-cleanup is best-effort either way.
  const runId = process.env.RUN_ID ?? `nosrunid-${randomUUID().slice(0, 8)}`;
  const browserCount = specs.filter((spec) => spec.browser !== undefined).length;
  let browserProvider: BrowserProvider | null = null;
  if (browserCount > 0) {
    browserProvider = selectBrowserProvider();
  }

  // Pick the runtime backend deterministically from `INTEGRATION_RUNTIME_ADAPTER`
  // (the launching orchestrator pins it to mirror `RUN_ADAPTER` — no probing).
  // The selection logic is in {@link selectIntegrationRuntimeAdapter}; adding a
  // new backend (firecracker, podman) means dropping a new
  // `integration-runtime-adapter-*.ts` module that calls
  // `registerIntegrationRuntimeAdapter()`.
  let adapter: IntegrationRuntimeAdapter;
  try {
    adapter = selectIntegrationRuntimeAdapter();
  } catch (err) {
    logger.error("integration runtime adapter selection failed", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  // ─── Phase 1.5 (kickoff) — MITM run-CA mint, raced with adapter.prepare ───
  // The CA mint (openssl keygen + self-sign, ~100 ms) only needs the runId;
  // it has no dependency on the adapter context, so it runs concurrently
  // with `adapter.prepare` instead of serializing after it — the agent's
  // boot-report gate waits on the slower of the two, not their sum. The
  // result is awaited (with its breadcrumb) right after the adapter phase.
  const mitmIntegrationCount = specs.filter(
    (s) => s.httpDeliveryAuths && Object.keys(s.httpDeliveryAuths).length > 0,
  ).length;
  const caStart = performance.now();
  const runCaPromise = mitmIntegrationCount > 0 ? prepareRunCa(runId, "afps-ca-") : null;
  // Rejection is handled at the await below; this guard only prevents an
  // unhandled-rejection crash if adapter.prepare throws first.
  runCaPromise?.catch(() => {});

  const adapterPrepareStart = performance.now();
  const [adapterPreparation, browserPreparation] = await Promise.allSettled([
    adapter.prepare(runId),
    browserProvider?.prepare(runId) ?? Promise.resolve(null),
  ]);
  if (adapterPreparation.status === "rejected" || browserPreparation.status === "rejected") {
    await adapter.shutdown().catch(() => {});
    await browserProvider?.shutdown().catch(() => {});
    if (runCaPromise) {
      const pendingCa = await runCaPromise.catch(() => null);
      if (pendingCa) await disposeRunCa(pendingCa);
    }
    throw adapterPreparation.status === "rejected"
      ? adapterPreparation.reason
      : browserPreparation.status === "rejected"
        ? browserPreparation.reason
        : new Error("integration runtime preparation failed");
  }
  const adapterCtx = adapterPreparation.value;
  const adapterPrepareMs = performance.now() - adapterPrepareStart;
  // Decode the workspace handle once for the whole run — same handle is
  // shared by every opt-in integration runner. The agent already has
  // the underlying workspace mounted; this surfaces it to mcp-server
  // runners that declared `_meta["dev.appstrate/workspace"]`.
  const workspaceHandle = decodeWorkspaceHandle();
  if (workspaceHandle) {
    breadcrumbs.push({
      message: `shared workspace available (${workspaceHandle.kind})`,
      level: "info",
      data:
        workspaceHandle.kind === "volume"
          ? { kind: workspaceHandle.kind, name: workspaceHandle.name }
          : { kind: workspaceHandle.kind, path: workspaceHandle.path },
    });
  }
  logger.info("integration runtime selected", {
    adapter: adapter.id,
    listenerBindHost: adapterCtx.listenerBindHost,
    integrations: specs.length,
  });
  breadcrumbs.push({
    message: `runtime adapter: ${adapter.id}`,
    level: "info",
    data: { adapter: adapter.id, prepareMs: Math.round(adapterPrepareMs) },
  });

  // ─── Phase 1.5 (converge) — MITM bring-up (run-CA + cert minter) ───
  // The CA was minted once per run (kicked off above, concurrent with the
  // adapter phase), regardless of how many integrations need it.
  // Per-integration listeners share the same minter (lazily creates leaf
  // certs per upstream SNI host). The CA cert PEM lands on local fs so
  // the adapter can ferry it into each runner's trust store.
  let runCa: RunCaMaterials | null = null;
  if (runCaPromise) {
    try {
      runCa = await runCaPromise;
      const caMs = Math.round(performance.now() - caStart);
      logger.info("integration MITM CA minted", {
        runId,
        integrations: mitmIntegrationCount,
        caCertPath: runCa.certHostPath,
        notAfter: runCa.bundle.notAfter,
      });
      breadcrumbs.push({
        message: `MITM CA minted (${mitmIntegrationCount} integration${mitmIntegrationCount === 1 ? "" : "s"}, ${caMs}ms)`,
        level: "info",
        data: { integrations: mitmIntegrationCount, durationMs: caMs },
      });
    } catch (err) {
      // CA bring-up failed — every MITM integration will fail to register
      // below and land in `failed`, which aborts the run. We log + breadcrumb
      // the root cause here so the per-integration failures downstream are
      // attributable (typically openssl missing from the sidecar image).
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("integration MITM CA bring-up failed; HTTP-delivery integrations will skip", {
        runId,
        error: msg,
      });
      breadcrumbs.push({
        message: `MITM CA bring-up failed: ${msg}`,
        level: "warn",
        data: { error: msg },
      });
    }
  }

  for (const spec of specs) {
    const specStart = performance.now();
    let pendingBrowser: { handle: BrowserHandle; gateway: BrowserEgressGatewayHandle } | undefined;
    let pendingGateway: BrowserEgressGatewayHandle | undefined;
    // #779 — bounded tail of the runner's stderr, folded into the failure
    // report below so the real cause (an OAuth 405, a crashed module, …)
    // reaches operators instead of living only in `docker logs`.
    const stderrTail: string[] = [];
    try {
      const nativeHiddenTools = hiddenToolsForNativeUpstream(spec);
      // ─── ONE shared credentials source per integration ───
      // The Source/Sink model (see integration-credentials-source.ts header):
      // a single source feeds every consumer of this integration's credentials
      // — the MITM listener, the api_call adapter, and the connect-login hook.
      // Sharing it is what makes a connect.tool run-start session (installed via
      // `setSessionOutputs`) visible to api_call on the same authKey, and keeps
      // the refresh dedup / cooldown / re-login handler coherent across sinks.
      // Created (and its initial credentials fetched) exactly once here.
      const hasApiCall = (spec.apiCalls?.length ?? 0) > 0;
      const hasHttpDelivery =
        spec.httpDeliveryAuths !== undefined && Object.keys(spec.httpDeliveryAuths).length > 0;
      const needsSource =
        hasHttpDelivery ||
        hasApiCall ||
        spec.sourceKind === "remote" ||
        (spec.browserConnect?.sessionMode === "exportable" &&
          spec.browserConnect.deliveryHttp !== undefined);
      const source = needsSource
        ? createIntegrationCredentialsSource({
            integrationId: spec.integrationId,
            platformApiUrl: bundleFetchOpts.platformApiUrl,
            runToken: bundleFetchOpts.runToken,
            initialPayload: await fetchInitialIntegrationCredentials(
              spec.integrationId,
              bundleFetchOpts,
            ),
          })
        : null;

      // ─── generic api_call tool ───
      // Independent of how (or whether) the integration spawns a server:
      // read the SHARED source above, then host the generic `api_call` (+
      // optional `api_upload`) tools as
      // a TRUSTED in-process MCP server on the same McpHost as every
      // spawned/remote integration — OUTSIDE any spawned container, so the
      // server code never sees the credential. One pipeline → McpHost owns
      // the namespacing (`{ns}__api_call`) + name validation. Two modes:
      //  - serverless (`apiCall` block, no `spec.manifest.server`): api_call
      //    is the namespace's PRIMARY client (`intoNamespace` omitted) and the
      //    integration does ONLY this, skipping spawn.
      //  - attachable (additive on a spawned/remote server): pass the server's
      //    ALLOCATED namespace so `{ns}__api_call` sits next to the native
      //    tools under one namespace; the spawned server stays primary.
      // Returns the number of tools added so callers can sum the tool count.
      const attachApiCall = async (intoNamespace?: string): Promise<number> => {
        const apiCalls = spec.apiCalls ?? [];
        if (apiCalls.length === 0) return 0;
        if (!apiCallDeps) {
          logger.warn("integration declares api_call but sidecar has no proxy deps; skipping", {
            integrationId: spec.integrationId,
          });
          return 0;
        }
        if (!source) {
          // Unreachable: `hasApiCall` forces `needsSource`, so the source always
          // exists when there are api_calls. Guard narrows the type + fails loud
          // if that invariant ever breaks.
          logger.warn("integration declares api_call but no credentials source was hoisted", {
            integrationId: spec.integrationId,
          });
          return 0;
        }
        // The SHARED source serves every auth; each api_call entry binds its own
        // auth via a per-auth adapter reading from that same source.
        let total = 0;
        // A serverless multi-auth integration has no primary MCP upstream to
        // allocate its namespace before these synthetic tools are attached.
        // The first api_call registration therefore becomes the primary; all
        // subsequent auth-scoped api_call servers must merge into the exact
        // namespace it was allocated (which may already carry a collision
        // suffix). Otherwise McpHost allocates `namespace_2` for the second
        // auth and the runtime surface drifts from the integration catalog.
        let sharedNamespace = intoNamespace;
        for (const apiCall of apiCalls) {
          const credAdapter = createApiCallCredentialAdapter({
            source,
            authKey: apiCall.authKey,
            authorizedUris: apiCall.authorizedUris,
            ...(apiCall.allowAllUris ? { allowAllUris: true } : {}),
          });
          const integ: ApiCallIntegrationConfig = {
            namespace: spec.namespace, // McpHost.register normalises it
            integrationId: spec.integrationId,
            toolName: apiCall.toolName,
            fetchCredentials: credAdapter.fetchCredentials,
            refreshCredentials: credAdapter.refreshCredentials,
            // Resumable-upload protocols the manifest declared (plumbed via
            // the spawn resolver). When non-empty the factory also emits an
            // `api_upload` tool; the agent-side resolver drives it.
            ...(apiCall.uploadProtocols && apiCall.uploadProtocols.length > 0
              ? { uploadProtocols: apiCall.uploadProtocols }
              : {}),
          };
          const defs = createApiCallToolDefs(integ, apiCallDeps);
          // `api_upload` cannot execute without its api_call sibling. Preserve
          // the useful asymmetric hidden_tools semantics: hiding only upload
          // leaves api_call available, while hiding api_call also hides every
          // companion emitted by this auth-scoped definition set.
          const effectiveHiddenTools = new Set(spec.hiddenTools ?? []);
          if (effectiveHiddenTools.has(apiCall.toolName)) {
            for (const def of defs) effectiveHiddenTools.add(def.descriptor.name);
          }
          const pair = await createInProcessPair(defs, {
            serverInfo: {
              name: `appstrate-api-call-${spec.integrationId}-${apiCall.toolName}`,
              version: "1",
            },
          });
          const wrapped = wrapClient(pair.client, { close: () => pair.close() });
          const sizeBefore = host.size();
          const merging = sharedNamespace !== undefined;
          const allocatedNamespace = await host.register({
            namespace: spec.namespace,
            client: wrapped,
            trusted: true,
            allowedTools: defs.map((d) => d.descriptor.name),
            // `hidden_tools` is a runtime boundary, not merely catalog/UI
            // metadata. Synthetic api_call/api_upload descriptors go through
            // the same defensive filter as spawned/remote MCP tools.
            ...(effectiveHiddenTools.size > 0 ? { hiddenTools: [...effectiveHiddenTools] } : {}),
            ...(sharedNamespace ? { intoNamespace: sharedNamespace } : {}),
          });
          sharedNamespace ??= allocatedNamespace;
          const count = host.size() - sizeBefore;
          clients.push(wrapped);
          total += count;
          logger.info("integration api_call registered (in-process)", {
            integrationId: spec.integrationId,
            namespace: allocatedNamespace,
            authKey: apiCall.authKey,
            toolName: apiCall.toolName,
            attached: merging,
            toolCount: count,
          });
        }
        return total;
      };

      // Serverless integration (api_call-only, no MCP server) — the in-process
      // api_call server is its entire surface (registered as the primary).
      // Dispatch on `sourceKind === "none"`; the resolver also leaves
      // `manifest.server` undefined for this branch.
      if (spec.sourceKind === "none" || !spec.manifest.server) {
        const apiCallToolCount = await attachApiCall();
        spawned.push({
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          toolCount: apiCallToolCount,
          // serverless integration — no `source.server`, so `vendored` is N/A.
        });
        const ms = Math.round(performance.now() - specStart);
        pushServerlessReadyBreadcrumb(spec, apiCallToolCount, ms, breadcrumbs);
        continue;
      }
      const server = spec.manifest.server;

      // ─── Phase 7 — remote HTTP MCP path ───
      // When the spawn-spec declares `sourceKind: "remote"` the integration
      // is a managed remote MCP (e.g. Google's gmailmcp.googleapis.com).
      // No bundle to fetch, no runner to spawn, no MITM listener — the
      // sidecar opens a Streamable HTTP client directly and injects the
      // Bearer token per-request from the credentials source. Trade-off:
      // Phase 4 URL-envelope enforcement is N/A (we can't enforce per-tool
      // upstream URLs through a hosted MCP — the upstream decides).
      if (spec.sourceKind === "remote") {
        if (!source) {
          // Unreachable: `sourceKind === "remote"` forces `needsSource`. Guard
          // narrows the type + fails loud if that invariant ever breaks.
          throw new Error(
            `remote integration ${spec.integrationId} has no hoisted credentials source`,
          );
        }
        const { client, authKey } = await connectRemoteHttpIntegration(spec, source);
        // Register on the caller-owned teardown collector BEFORE host.register
        // so a register failure (namespace collision / suffix exhaustion,
        // which throw before McpHost adds the client to its own set) still
        // closes the open Streamable HTTP client. Mirrors the local-spawn
        // path's leak-safe ordering.
        clients.push(client);
        const sizeBefore = host.size();
        const allocatedNs = await host.register({
          namespace: spec.namespace,
          client,
          // Phase 3 tool allowlist still applies — McpHost filters
          // tools/list before exposing them to the agent.
          allowedTools: spec.toolAllowlist,
          // R8a defensive — `manifest.hidden_tools` is enforced at
          // runtime as well as at install-time, so a manifest-hidden
          // tool can never reach the agent via the remote MCP path.
          ...(nativeHiddenTools ? { hiddenTools: nativeHiddenTools } : {}),
        });
        const added = host.size() - sizeBefore;
        pushUnavailableToolBreadcrumb(spec, added, breadcrumbs);
        // Attach the in-process api_call tool alongside the remote MCP's tools.
        const apiCallAdded = await attachApiCall(allocatedNs);
        spawned.push({
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          toolCount: added + apiCallAdded,
          // remote-source integration — no `source.server.vendored` field.
        });
        logger.info("integration registered (remote http)", {
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          serverUrl: server.url,
          // AFPS §7.1 — surface the actual transport the sidecar
          // dispatched to so operators can audit which path executed.
          transport: server.transport ?? "streamable-http",
          authKey,
          toolCount: added + apiCallAdded,
        });
        const ms = Math.round(performance.now() - specStart);
        breadcrumbs.push({
          message: `${spec.integrationId}: remote-http connect ${ms}ms · ready`,
          level: "info",
          data: {
            integrationId: spec.integrationId,
            kind: "remote-http",
            durationMs: ms,
            toolCount: added + apiCallAdded,
          },
        });
        continue;
      }

      // ─── SINGLE spawn→connect→register pipeline (shared with connect-run) ──
      // MITM is created only when the CA came up AND this integration declared
      // `delivery.http`. `mitmSource` is returned so the connect-login hook
      // (run-start acquisition, below) drives `setSessionOutputs` on the same
      // source the MITM listener reads from. `wantsEgress` (#543) is the
      // fallback: a no-injection runner that still needs an outbound route gets
      // a plain CONNECT egress listener instead.
      const wantsMitm =
        spec.httpDeliveryAuths !== undefined && Object.keys(spec.httpDeliveryAuths).length > 0;
      const wantsEgress = spec.needsEgress === true;
      if (spec.browser) {
        if (!browserProvider) {
          throw new Error("BROWSER_UNAVAILABLE: no browser provider was selected");
        }
        const gatewayToken = randomBytes(32).toString("base64url");
        const guestIsolation = isFirecrackerBrowserIsolation();
        const isolationSlot = guestIsolation
          ? assertBrowserIsolationSlot(spec.browser.isolationSlot)
          : undefined;
        const gateway = createBrowserEgressGateway({
          authToken: gatewayToken,
          allowedOrigins: spec.browser.allowedOrigins,
          ...(bundleFetchOpts.proxyUrl ? { upstreamProxyUrl: bundleFetchOpts.proxyUrl } : {}),
          host: adapterCtx.listenerBindHost,
          ...(isolationSlot === undefined ? {} : { port: browserGatewayPort(isolationSlot) }),
          resolveHostFn: bundleFetchOpts.resolveHostFn,
          onEvent: (event) =>
            logger.info("browser gateway event", {
              integrationId: spec.integrationId,
              ...event,
            }),
        });
        await gateway.ready;
        pendingGateway = gateway;
        const handle = await browserProvider.spawn({
          runId,
          integrationId: spec.integrationId,
          spec: spec.browser,
          egress: {
            proxyUrl: adapterCtx.proxyUrlFor(gateway.address().port),
            authToken: gatewayToken,
          },
          resources: STANDARD_BROWSER_PROFILE,
        });
        pendingBrowser = { handle, gateway };
        assertBrowserWorkerCompatible(spec.browser.protocol, handle);
        browserResources.push(pendingBrowser);
        breadcrumbs.push({
          message: `${spec.integrationId}: browser worker ready`,
          level: "info",
          data: {
            integrationId: spec.integrationId,
            provider: browserProvider.id,
            workerBuildId: handle.workerBuildId,
            protocolVersion: handle.protocolVersion,
            browserRevision: handle.browserRevision,
            ...(handle.diagnosticId ? { diagnosticId: handle.diagnosticId } : {}),
          },
        });
      }
      const {
        allocatedNs,
        mitmSource,
        toolCount: added,
        diagnosticId,
        spawnMs,
        connectMs,
      } = await spawnAndConnectLocalIntegration({
        spec,
        runId,
        adapter,
        adapterCtx,
        host,
        bundleFetchOpts,
        source,
        ca: runCa,
        workspaceHandle,
        wantsMitm,
        wantsEgress,
        ...(pendingBrowser ? { browser: pendingBrowser.handle } : {}),
        allowedTools: spec.toolAllowlist,
        // R8a — propagate `hidden_tools` so the host filters them out at
        // runtime, regardless of whether install-time validation removed them.
        ...(nativeHiddenTools ? { hiddenTools: nativeHiddenTools } : {}),
        logLabel: "integration",
        clients,
        mitmListeners,
        stderrTail,
      });
      pushUnavailableToolBreadcrumb(spec, added, breadcrumbs);

      // ─── P2 — connect.tool `runAt: "run-start"` session acquisition ───
      // Only the login secret was stored at dashboard connect; mint the
      // session now by running the integration's login tool. The secret is
      // substituted proxy-side (never handed to tool code) and the captured
      // session header becomes injectable for the rest of the run via
      // `source.setSessionOutputs` (called inside runConnectLogin).
      //
      // A failure here throws into the outer catch → the integration lands
      // on `failed` and is NOT pushed to `spawned`; the agent gets a
      // tool-error if it tries to use it rather than a silent half-session.
      // The connect-login tool is reached via the ALLOCATED namespace (the
      // host may have disambiguated `spec.namespace` with a suffix).
      if (spec.connectLogin) {
        await runConnectLoginHook(spec, host, mitmSource, allocatedNs);
      }
      if (spec.browserConnect) {
        if (!pendingBrowser || !spec.browser) {
          throw new Error("browser-connect: browser worker was not provisioned");
        }
        await runBrowserConnect({
          host,
          namespace: allocatedNs,
          connect: spec.browserConnect,
          browserSpec: spec.browser,
          browser: pendingBrowser.handle,
          source,
        });
        breadcrumbs.push({
          message: `${spec.integrationId}: browser connection proof succeeded`,
          level: "info",
          data: {
            integrationId: spec.integrationId,
            sessionMode: spec.browserConnect.sessionMode,
          },
        });
      }

      // Attach the in-process api_call tool alongside the spawned server's
      // native tools, under the same (allocated) namespace.
      const apiCallAdded = await attachApiCall(allocatedNs);

      spawned.push({
        integrationId: spec.integrationId,
        namespace: spec.namespace,
        toolCount: added + apiCallAdded,
        // AFPS §7.1 — forward the local source's `vendored` build-provenance
        // flag so the boot report surfaces it for audit/security consumers.
        ...(typeof spec.manifest.server?.vendored === "boolean"
          ? { vendored: spec.manifest.server.vendored }
          : {}),
      });
      logger.info("integration registered", {
        integrationId: spec.integrationId,
        namespace: spec.namespace,
        adapter: adapter.id,
        ...(diagnosticId ? { diagnosticId } : {}),
        toolCount: added + apiCallAdded,
      });
      const loginPart = spec.connectLogin
        ? " · login"
        : spec.browserConnect
          ? " · browser-login"
          : "";
      breadcrumbs.push({
        message: `${spec.integrationId}: spawn ${Math.round(spawnMs)}ms · connect ${Math.round(connectMs)}ms${loginPart} · ready`,
        level: "info",
        data: {
          integrationId: spec.integrationId,
          kind: "local",
          adapter: adapter.id,
          spawnMs: Math.round(spawnMs),
          connectMs: Math.round(connectMs),
          durationMs: Math.round(performance.now() - specStart),
          toolCount: added + apiCallAdded,
          ...(diagnosticId ? { diagnosticId } : {}),
        },
      });
    } catch (err) {
      if (pendingBrowser && browserProvider) {
        await browserProvider.stop(pendingBrowser.handle).catch(() => {});
        await pendingBrowser.gateway.close().catch(() => {});
        const index = browserResources.indexOf(pendingBrowser);
        if (index !== -1) browserResources.splice(index, 1);
      } else if (pendingGateway) {
        await pendingGateway.close().catch(() => {});
      }
      const msg = spec.browser
        ? browserSafeErrorCode(err)
        : err instanceof Error
          ? err.message
          : String(err);
      const ms = Math.round(performance.now() - specStart);
      // #779 — append the runner's stderr tail so the boot report carries
      // the actual upstream cause, not just the transport-level symptom
      // (e.g. "MCP connect timeout (30s)" hiding an OAuth 405 underneath).
      const stderrSuffix =
        stderrTail.length > 0
          ? ` — runner stderr (last ${stderrTail.length} line${stderrTail.length > 1 ? "s" : ""}): ${stderrTail.join(" ⏎ ")}`
          : "";
      failed.push({ integrationId: spec.integrationId, error: msg + stderrSuffix });
      logger.warn("integration spawn failed", {
        integrationId: spec.integrationId,
        error: msg,
        ...(stderrTail.length > 0 ? { stderrTail } : {}),
      });
      breadcrumbs.push({
        message: `${spec.integrationId}: failed after ${ms}ms — ${msg}${stderrSuffix}`,
        level: "error",
        data: { integrationId: spec.integrationId, durationMs: ms, error: msg },
      });
    }
  }

  const tools = host.buildTools();
  // Every spec exits the loop via exactly one path: success (→ spawned) or the
  // catch (→ failed), so `spawned.length + failed.length === specs.length`. The
  // run is healthy only when nothing failed — the agent reads `ok` to decide
  // whether to abort.
  const report: IntegrationBootReport = {
    ok: failed.length === 0,
    declared: specs.length,
    adapter: adapter.id,
    spawned,
    failed,
    breadcrumbs,
  };
  return {
    host,
    tools,
    spawned,
    failed,
    report,
    shutdown: async () => {
      await host.dispose().catch((err) => {
        logger.debug("integration host dispose failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      for (const c of clients) {
        await c.close().catch((err) => {
          logger.debug("integration client close failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      // Adapter teardown AFTER closing MCP clients — closing the client
      // ends the runner's stdio (subprocess EOF / docker-attach pipe
      // close → server exits → container/process exits). The adapter's
      // shutdown is the belt-and-suspenders path for misbehaving servers
      // that ignore stdin EOF.
      try {
        await adapter.shutdown();
      } catch (err) {
        logger.warn("integration adapter shutdown failed", {
          adapter: adapter.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Browser workers outlive their integration runner during the run, then
      // stop before their gateways so Chromium cannot escape through a stale
      // listener while teardown races.
      if (browserProvider) {
        for (const resource of browserResources) {
          await browserProvider.stop(resource.handle).catch(() => {});
        }
        await browserProvider.shutdown().catch((err) => {
          logger.warn("browser provider shutdown failed", {
            provider: browserProvider?.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        for (const resource of browserResources) {
          await resource.gateway.close().catch(() => {});
        }
        browserResources.length = 0;
      }
      // Close MITM listeners after the runtimes are torn down — listeners
      // hold open per-SNI Bun.serve sockets + cached leaf certs.
      for (const l of mitmListeners) {
        try {
          await l.close();
        } catch {
          // ignore — listener already torn down via SIGTERM
        }
      }
      if (runCa) await disposeRunCa(runCa);
    },
  };
}

/**
 * P4 — ephemeral connect-run (`runAt: "link"`). Spawn ONE integration's MCP
 * server, mint a per-run CA + MITM listener for it, run its `login` MCP tool
 * exactly ONCE via {@link runConnectLogin} (the secret substituted proxy-side),
 * capture the resulting {@link CredentialBundle}, then tear EVERYTHING down.
 *
 * This is the sidecar-side primitive the platform's `ConnectToolExecutor`
 * binding drives in connect mode (see `runtime-pi/sidecar/server.ts`). It
 * reuses the SAME building blocks `bootIntegrations` uses for the agent-run
 * path (runtime adapter spawn + per-run CA/MITM source + McpHost register +
 * `runConnectLogin`) but for a single integration, and RETURNS the bundle
 * rather than installing a long-lived session for an agent run.
 *
 * Unlike the agent-run path, `runConnectOnce` THROWS on any failure (no
 * `failed[]` accumulation) — the caller maps the throw onto the connect-run's
 * error result. The teardown (`finally`) runs even on error so no listener /
 * subprocess / CA file leaks past this primitive.
 *
 * The bundle's `outputs` are never logged — the caller transports them on the
 * sentinel line only.
 */
export async function runConnectOnce(
  spec: IntegrationSpawnSpec,
  bundleFetchOpts: BundleFetchOptions,
): Promise<CredentialBundle> {
  const cl = spec.connectLogin;
  if (!cl) {
    throw new Error("runConnectOnce: spec has no connectLogin block");
  }
  const server = spec.manifest.server;
  if (!server) {
    throw new Error("runConnectOnce: spec has no manifest.server to spawn");
  }
  if (spec.sourceKind === "remote") {
    throw new Error("runConnectOnce: remote http MCP integrations cannot run connect-login");
  }

  const runId = process.env.RUN_ID ?? `nosrunid-${randomUUID().slice(0, 8)}`;

  const adapter = selectIntegrationRuntimeAdapter();
  const adapterCtx = await adapter.prepare(runId);

  const host = new McpHost({
    onLog: (event) =>
      logger.info("connect-run host event", {
        source: event.source,
        level: event.level,
        data: event.data,
      }),
  });

  const clients: AppstrateMcpClient[] = [];
  const mitmListeners: MitmListenerHandle[] = [];
  let runCaCertHostPath: string | null = null;
  let runCaMinter: CertMinter | null = null;

  try {
    // Per-run CA — connect-login ALWAYS needs the MITM (the login secret is
    // substituted proxy-side; there is no plaintext-arg path), so unlike
    // `bootIntegrations` we let a CA failure throw rather than degrade.
    const ca = await prepareRunCa(runId, "afps-ca-connect-");
    runCaCertHostPath = ca.certHostPath;
    runCaMinter = ca.minter;

    // Hoist the single credentials source for this connect-run (mirrors
    // `bootIntegrations`). connect-login ALWAYS needs the MITM, so the source
    // is mandatory here — its initial payload is a placeholder session with an
    // empty value; the real session is what `runConnectLogin` captures via
    // `setSessionOutputs` on this same source.
    const source = createIntegrationCredentialsSource({
      integrationId: spec.integrationId,
      platformApiUrl: bundleFetchOpts.platformApiUrl,
      runToken: bundleFetchOpts.runToken,
      initialPayload: await fetchInitialIntegrationCredentials(spec.integrationId, bundleFetchOpts),
    });

    // Same spawn→connect→register pipeline the agent-run path uses, but
    // `allowedTools: []` (connect-run never serves an agent; register() is only
    // needed so `getUpstreamClient` resolves the login tool) and `wantsMitm`
    // forced on.
    const { allocatedNs, mitmSource } = await spawnAndConnectLocalIntegration({
      // connect-run never reaches an agent — the integration spawns only
      // long enough to mint a session, so workspace exposure is a
      // non-goal. Strip any `workspaceMount` the resolver attached so the
      // runtime adapter sees no opt-in: passing the mount + a null handle
      // would otherwise trip the adapter's "declared mount but no handle"
      // ERROR on every connect run for a workspace-opted-in mcp-server.
      spec: spec.workspaceMount ? { ...spec, workspaceMount: undefined } : spec,
      runId,
      adapter,
      adapterCtx,
      host,
      bundleFetchOpts,
      source,
      ca,
      // Always pass null to keep the connect-run path workspace-free
      // regardless of the launching orchestrator's env.
      workspaceHandle: null,
      wantsMitm: true,
      // connect-run always mounts the MITM listener (it provides egress too),
      // so the plain-egress fallback never applies here.
      wantsEgress: false,
      allowedTools: [],
      logLabel: "connect-run",
      clients,
      mitmListeners,
    });
    if (!mitmSource) {
      // Unreachable: wantsMitm=true + ca!=null always builds the source. Guard
      // narrows the type and fails loudly if that invariant ever breaks.
      throw new Error("runConnectOnce: MITM source was not created");
    }

    // Run the login tool ONCE and capture the bundle. The secret in
    // `cl.inputs` is substituted proxy-side by the MITM source.
    const bundle = await runConnectLogin({
      host,
      namespace: allocatedNs,
      toolName: cl.toolName,
      ...(cl.produces ? { produces: cl.produces } : {}),
      inputs: cl.inputs,
      source: mitmSource,
      authKey: cl.authKey,
      authType: cl.authType,
      authorizedUris: cl.authorizedUris,
      deliveryHttp: cl.deliveryHttp,
    });

    logger.info("connect-run captured session", {
      integrationId: spec.integrationId,
      authKey: cl.authKey,
      outputCount: Object.keys(bundle.outputs).length,
    });

    return bundle;
  } finally {
    await host.dispose().catch(() => {});
    for (const c of clients) {
      await c.close().catch(() => {});
    }
    try {
      await adapter.shutdown();
    } catch (err) {
      logger.warn("connect-run adapter shutdown failed", {
        adapter: adapter.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    for (const l of mitmListeners) {
      try {
        await l.close();
      } catch {
        // ignore — listener already torn down
      }
    }
    if (runCaMinter) await runCaMinter.dispose();
    if (runCaCertHostPath) {
      try {
        await rm(runCaCertHostPath, { force: true });
      } catch {
        // ignore — best-effort
      }
    }
  }
}

/** Trusted browser link-acquisition lifecycle. It is intentionally separate
 * from runConnectOnce: bootstrap inputs go directly to an authorized driver,
 * never through the ordinary secret-blind MITM substitution contract. */
export async function runBrowserConnectOnce(
  spec: IntegrationSpawnSpec,
  bundleFetchOpts: BundleFetchOptions,
): Promise<BrowserAcquisitionResult> {
  if (!spec.browser || !spec.browserConnect) {
    throw new Error("runBrowserConnectOnce: spec has no browser acquisition contract");
  }
  if (
    spec.browser.purpose !== "connection-acquisition" ||
    !spec.browser.trustedDriver ||
    !spec.browser.driverGrantId
  ) {
    throw new Error("runBrowserConnectOnce: driver is not authorized for secret-aware browser use");
  }
  if (!spec.manifest.server || spec.sourceKind !== "local") {
    throw new Error("runBrowserConnectOnce: browser acquisition requires a local mcp-server");
  }

  const runId = process.env.RUN_ID ?? `nosrunid-${randomUUID().slice(0, 8)}`;
  const adapter = selectIntegrationRuntimeAdapter();
  const browserProvider = selectBrowserProvider();
  const host = new McpHost();
  const clients: AppstrateMcpClient[] = [];
  const listeners: MitmListenerHandle[] = [];
  let gateway: BrowserEgressGatewayHandle | null = null;
  let browser: BrowserHandle | null = null;
  try {
    const [adapterPreparation, browserPreparation] = await Promise.allSettled([
      adapter.prepare(runId),
      browserProvider.prepare(runId),
    ]);
    if (adapterPreparation.status === "rejected" || browserPreparation.status === "rejected") {
      throw adapterPreparation.status === "rejected"
        ? adapterPreparation.reason
        : browserPreparation.status === "rejected"
          ? browserPreparation.reason
          : new Error("browser connect runtime preparation failed");
    }
    const adapterCtx = adapterPreparation.value;
    const gatewayToken = randomBytes(32).toString("base64url");
    const guestIsolation = isFirecrackerBrowserIsolation();
    const isolationSlot = guestIsolation
      ? assertBrowserIsolationSlot(spec.browser.isolationSlot)
      : undefined;
    gateway = createBrowserEgressGateway({
      authToken: gatewayToken,
      allowedOrigins: spec.browser.allowedOrigins,
      ...(bundleFetchOpts.proxyUrl ? { upstreamProxyUrl: bundleFetchOpts.proxyUrl } : {}),
      host: adapterCtx.listenerBindHost,
      ...(isolationSlot === undefined ? {} : { port: browserGatewayPort(isolationSlot) }),
      resolveHostFn: bundleFetchOpts.resolveHostFn,
    });
    await gateway.ready;
    browser = await browserProvider.spawn({
      runId,
      integrationId: spec.integrationId,
      spec: spec.browser,
      egress: {
        proxyUrl: adapterCtx.proxyUrlFor(gateway.address().port),
        authToken: gatewayToken,
      },
      resources: STANDARD_BROWSER_PROFILE,
    });
    assertBrowserWorkerCompatible(spec.browser.protocol, browser);
    const { allocatedNs } = await spawnAndConnectLocalIntegration({
      spec: spec.workspaceMount ? { ...spec, workspaceMount: undefined } : spec,
      runId,
      adapter,
      adapterCtx,
      host,
      bundleFetchOpts,
      source: null,
      ca: null,
      workspaceHandle: null,
      wantsMitm: false,
      wantsEgress: false,
      browser,
      allowedTools: [],
      logLabel: "browser-connect-run",
      clients,
      mitmListeners: listeners,
    });
    return await runBrowserConnect({
      host,
      namespace: allocatedNs,
      connect: spec.browserConnect,
      browserSpec: spec.browser,
      browser,
      source: null,
      installExportedSession: false,
    });
  } finally {
    await host.dispose().catch(() => {});
    for (const client of clients) await client.close().catch(() => {});
    await adapter.shutdown().catch(() => {});
    if (browser) await browserProvider.stop(browser).catch(() => {});
    await browserProvider.shutdown().catch(() => {});
    await gateway?.close().catch(() => {});
  }
}
