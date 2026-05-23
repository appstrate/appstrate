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
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createInProcessPair,
  createMcpHttpClient,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { planCaBundle, type CaBundle } from "@appstrate/connect/proxy-ca-planner";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

import type { CredentialBundle } from "@appstrate/connect/connect";

import { McpHost } from "./mcp-host.ts";
import { logger } from "./logger.ts";
import { createOpensslCertGenerator } from "./ca-cert-openssl.ts";
import { createCertMinter, type CertMinter } from "./integration-cert-minter.ts";
import {
  createIntegrationMitmListener,
  type MitmListenerHandle,
} from "./integration-mitm-listener.ts";
import {
  createIntegrationCredentialsSource,
  fetchInitialIntegrationCredentials,
  type IntegrationCredentialsSource,
} from "./integration-credentials-source.ts";
import { createApiCallCredentialAdapter } from "./api-call-credentials.ts";
import { runConnectLogin } from "./connect-login.ts";
import {
  createApiCallToolDefs,
  type ApiCallIntegrationConfig,
  type ApiCallToolDeps,
} from "./mcp.ts";
import {
  selectIntegrationRuntimeAdapter,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type RuntimeMitmContext,
} from "./integration-runtime-adapter.ts";
// Side-effect imports — each adapter module registers itself on load.
// New adapters (firecracker, podman, …) plug in with one more import here.
import "./integration-runtime-adapter-docker.ts";
import "./integration-runtime-adapter-process.ts";

/**
 * Re-export the canonical spawn-spec type from `@appstrate/core/sidecar-types`
 * so adapter modules can import it from the same file that owns the rest of
 * the sidecar boot surface.
 */
export type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

/**
 * Where the sidecar fetches integration bundles from. The platform
 * surface is `GET /internal/integration-bundle/:scope/:name` with
 * Bearer-token auth (same run-token as the credentials endpoint).
 */
export interface BundleFetchOptions {
  platformApiUrl: string;
  runToken: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
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
  spawned: Array<{ integrationId: string; namespace: string; toolCount: number }>;
  /** Per-integration failures — emitted as warnings but do not abort boot. */
  failed: Array<{ integrationId: string; error: string }>;
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
 * Fetch one integration's bundle from the platform's internal surface.
 * The endpoint authorises with the same Bearer run-token as the
 * credentials surface and verifies that the run's agent actually
 * declares this integration as a dependency.
 */
async function fetchBundleBytes(
  integrationId: string,
  opts: BundleFetchOptions,
): Promise<Uint8Array> {
  const url = `${opts.platformApiUrl}/internal/integration-bundle/${integrationId}`;
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
      detail || `Failed to fetch integration bundle for ${integrationId}: HTTP ${res.status}`,
    );
  }
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Extract a ZIP bundle (already-bytes) to a fresh directory under
 * `os.tmpdir()`. Path traversal is defended in depth: every entry is
 * normalised + the resolved path must remain under the extraction root.
 */
async function extractBundle(bytes: Uint8Array, namespace: string): Promise<string> {
  // Namespace is the integration package id (e.g. `@scope/name`). Both `@`
  // and `/` are illegal in a mkdtemp template under macOS/Linux — collapse
  // to a path-safe slug. The directory is private to this run anyway.
  const safe = namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const root = await mkdtemp(join(tmpdir(), `afps-integ-${safe}-`));
  const files = unzipSync(bytes);
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
 * Auth selection: prefers an oauth2 auth (canonical Bearer + refresh),
 * otherwise picks the first auth that has a non-null delivery plan.
 * Throws when no auth produces an injectable header — Phase 7 can't run
 * an MCP client without authentication (every public hosted MCP today
 * gates `tools/call` behind some credential).
 */
async function connectRemoteHttpIntegration(
  spec: IntegrationSpawnSpec,
  bundleFetchOpts: BundleFetchOptions,
): Promise<{ client: AppstrateMcpClient; authKey: string }> {
  const serverUrl = spec.manifest.server?.url;
  if (!serverUrl) {
    throw new Error(
      `integration ${spec.integrationId} declares server.type="http" but no server.url`,
    );
  }

  const initial = await fetchInitialIntegrationCredentials(spec.integrationId, bundleFetchOpts);

  // Pick the auth whose header we'll inject. OAuth2 wins (refresh-aware);
  // otherwise the first auth with a resolved plan. The credentials
  // resolver populates `deliveryPlans[authKey]` for every auth declaring
  // `delivery.http` — including `{}` (empty), which defaults per
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
      `integration ${spec.integrationId} server.type="http" has no auth with a resolvable delivery.http plan`,
    );
  }
  const authKey = pickedAuth.authKey;

  const source = createIntegrationCredentialsSource({
    integrationId: spec.integrationId,
    platformApiUrl: bundleFetchOpts.platformApiUrl,
    runToken: bundleFetchOpts.runToken,
    initialPayload: initial,
  });

  // Per-request header reader. Reading from the snapshot on every call
  // means an OAuth refresh (which swaps `payload` in place) is picked up
  // automatically — no MCP transport restart needed. Static creds
  // (api_key) just return the same value forever.
  const readHeader = (): { name: string; value: string } | null => {
    const plan = source.snapshot().deliveryPlans[authKey];
    if (!plan) return null;
    return { name: plan.headerName, value: `${plan.headerPrefix}${plan.value}` };
  };

  const customFetch: typeof fetch = async (input, init) => {
    const send = async (): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const h = readHeader();
      if (h) headers.set(h.name, h.value);
      return fetch(input, { ...init, headers });
    };
    let res = await send();
    if (res.status === 401 && source.refreshOnUnauthorized) {
      const refreshed = await source.refreshOnUnauthorized(authKey).catch(() => false);
      if (refreshed) res = await send();
    }
    return res;
  };

  const client = await createMcpHttpClient(serverUrl, {
    fetch: customFetch,
    clientInfo: { name: "appstrate-sidecar-remote-integration", version: "0.1.0" },
    retry: { deadlineMs: 30_000 },
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
async function spawnAndConnectLocalIntegration(params: {
  spec: IntegrationSpawnSpec;
  runId: string;
  adapter: IntegrationRuntimeAdapter;
  adapterCtx: RuntimeAdapterRunContext;
  host: McpHost;
  bundleFetchOpts: BundleFetchOptions;
  /** Per-run CA materials; null disables MITM (env-delivery-only path). */
  ca: RunCaMaterials | null;
  /** Front this integration with a MITM listener (also needs `ca`). */
  wantsMitm: boolean;
  /** Phase 4 tool-URL envelope to enforce; omitted for connect-run. */
  toolUrlEnvelope?: IntegrationSpawnSpec["toolUrlEnvelope"];
  /** Allowlist for `host.register`. `[]` exposes nothing (connect-run). */
  allowedTools: string[] | undefined;
  /** Log-message prefix: `"integration"` (agent-run) | `"connect-run"`. */
  logLabel: string;
  /** Caller-owned teardown collectors — appended to as resources are built. */
  clients: AppstrateMcpClient[];
  mitmListeners: MitmListenerHandle[];
}): Promise<SpawnAndConnectResult> {
  const { spec, runId, adapter, adapterCtx, host, bundleFetchOpts, ca, logLabel } = params;

  let mitmCtx: RuntimeMitmContext | null = null;
  let mitmSource: IntegrationCredentialsSource | null = null;
  if (params.wantsMitm && ca !== null) {
    const initial = await fetchInitialIntegrationCredentials(spec.integrationId, bundleFetchOpts);
    const source = createIntegrationCredentialsSource({
      integrationId: spec.integrationId,
      platformApiUrl: bundleFetchOpts.platformApiUrl,
      runToken: bundleFetchOpts.runToken,
      initialPayload: initial,
    });
    mitmSource = source;
    const listener = createIntegrationMitmListener({
      caBundle: ca.bundle,
      minter: ca.minter,
      credentials: source,
      // Adapter decides where the listener binds so the runner can reach it
      // (0.0.0.0 for bridged networks, 127.0.0.1 when it shares the parent NS).
      host: adapterCtx.listenerBindHost,
      // Phase 4 — narrow the per-request URL surface to the union of
      // agent-selected tool urlPatterns. `undefined` leaves enforcement on the
      // per-auth `authorizedUris` only (connect-run omits it entirely).
      ...(params.toolUrlEnvelope ? { toolUrlEnvelope: params.toolUrlEnvelope } : {}),
      onEvent: (event) => {
        // Filter sensitive bits (URLs may carry signed query params).
        const safe =
          event.kind === "request-forwarded"
            ? {
                kind: event.kind,
                status: event.status,
                authKey: event.authKey,
                retried: event.retried,
              }
            : event;
        logger.info(`${logLabel} mitm event`, { integrationId: spec.integrationId, ...safe });
      },
    });
    await listener.ready;
    params.mitmListeners.push(listener);
    const port = listener.address().port;
    mitmCtx = { proxyUrl: adapterCtx.proxyUrlFor(port), caCertHostPath: ca.certHostPath };
    logger.info(`${logLabel} MITM listener ready`, {
      integrationId: spec.integrationId,
      localUrl: listener.proxyUrl(),
      runnerProxyUrl: mitmCtx.proxyUrl,
    });
  }

  const bytes = await fetchBundleBytes(spec.integrationId, bundleFetchOpts);
  const root = await extractBundle(bytes, spec.namespace);

  const spawnedIntegration = await adapter.spawn({
    runId,
    spec,
    bundleRoot: root,
    mitm: mitmCtx,
    onStderrLine: (line) => {
      logger.info(`${logLabel} integration stderr`, { integrationId: spec.integrationId, line });
    },
  });

  const client = new Client({ name: "appstrate-sidecar-integration-host", version: "0.1.0" });
  const connectPromise = client.connect(spawnedIntegration.transport);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("MCP connect timeout (30s)")), 30_000);
    timeoutId.unref?.();
  });
  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
  const wrapped = wrapClient(client, spawnedIntegration.transport);
  params.clients.push(wrapped);

  const sizeBefore = host.size();
  const allocatedNs = await host.register({
    namespace: spec.namespace,
    client: wrapped,
    // Niveau 2 Phase 3 — McpHost.register filters `tools/list` to the agent's
    // declared tools. `undefined` keeps the legacy "all tools allowed".
    ...(params.allowedTools !== undefined ? { allowedTools: params.allowedTools } : {}),
  });
  const toolCount = host.size() - sizeBefore;

  return {
    wrapped,
    allocatedNs,
    mitmSource,
    toolCount,
    ...(spawnedIntegration.diagnosticId ? { diagnosticId: spawnedIntegration.diagnosticId } : {}),
  };
}

/**
 * Spawn every integration in parallel, register the surviving ones on a
 * shared {@link McpHost}, and return the materialised tool list. The
 * function never throws — per-integration failures are captured in
 * `result.failed` so a single broken integration doesn't black-hole the
 * entire run.
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
  const clients: AppstrateMcpClient[] = [];
  const mitmListeners: MitmListenerHandle[] = [];

  // The sidecar receives RUN_TOKEN but not always RUN_ID directly — we
  // need a stable identifier for labelling integration containers
  // (lets the orphan reaper match containers back to their run if the
  // sidecar dies mid-shutdown). NEVER derive this from RUN_TOKEN: even
  // a 12-char slice of the signed token would leak ~72 bits of secret
  // entropy via `docker inspect` (labels are visible to anyone who can
  // talk to the daemon). Fall back to an opaque random id when RUN_ID
  // isn't available — orphan-cleanup is best-effort either way.
  const runId = process.env.RUN_ID ?? `nosrunid-${randomUUID().slice(0, 8)}`;

  // Pick the runtime backend (docker if reachable, otherwise the
  // in-process fallback). The selection logic is in
  // {@link selectIntegrationRuntimeAdapter}; adding a new backend
  // (firecracker, podman) means dropping a new
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
  const adapterCtx = await adapter.prepare(runId);
  logger.info("integration runtime selected", {
    adapter: adapter.id,
    listenerBindHost: adapterCtx.listenerBindHost,
    integrations: specs.length,
  });

  // ─── Phase 1.5 — MITM bring-up (run-CA + cert minter), only when needed ───
  // Mint the CA once per run, regardless of how many integrations need it.
  // Per-integration listeners share the same minter (lazily creates leaf
  // certs per upstream SNI host). The CA cert PEM lands on local fs so
  // the adapter can ferry it into each runner's trust store.
  const mitmIntegrationCount = specs.filter(
    (s) => s.httpDeliveryAuths && Object.keys(s.httpDeliveryAuths).length > 0,
  ).length;
  let runCa: RunCaMaterials | null = null;
  if (mitmIntegrationCount > 0) {
    try {
      runCa = await prepareRunCa(runId, "afps-ca-");
      logger.info("integration MITM CA minted", {
        runId,
        integrations: mitmIntegrationCount,
        caCertPath: runCa.certHostPath,
        notAfter: runCa.bundle.notAfter,
      });
    } catch (err) {
      // CA bring-up failed — every MITM integration will fail to register
      // below; non-MITM integrations stay on the env-delivery-only path.
      // We don't abort: the env-only path is still useful in dev / when
      // openssl is missing from the sidecar image.
      logger.warn("integration MITM CA bring-up failed; HTTP-delivery integrations will skip", {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const spec of specs) {
    try {
      // ─── provider→integration unification — generic api_call tool ───
      // Independent of how (or whether) the integration spawns a server:
      // build the credential adapter from a dedicated credentials source,
      // then host the generic `api_call` (+ optional `api_upload`) tools as
      // a TRUSTED in-process MCP server registered on the same McpHost as
      // every spawned/remote integration. One pipeline → McpHost owns the
      // namespacing (`{ns}__api_call`) + name validation. A pure-proxy
      // integration (an `apiCall` block, no `spec.manifest.server`) does
      // ONLY this and skips spawn.
      // Attach the in-process generic `api_call` tool (provider→integration
      // unification). Hosted on the McpHost OUTSIDE any spawned container, so
      // the server code never sees the credential. Two modes:
      //  - serverless (`apiCall` block, no `spec.manifest.server`):
      //    api_call is the namespace's PRIMARY client (`intoNamespace` omitted).
      //  - attachable (additive on a spawned/remote server): pass the server's
      //    ALLOCATED namespace so `{ns}__api_call` sits next to the native
      //    tools under one namespace; the spawned server stays primary.
      // Returns the number of tools added so callers can sum the tool count.
      const attachApiCall = async (intoNamespace?: string): Promise<number> => {
        if (!spec.apiCall) return 0;
        if (!apiCallDeps) {
          logger.warn("integration declares api_call but sidecar has no proxy deps; skipping", {
            integrationId: spec.integrationId,
          });
          return 0;
        }
        const initial = await fetchInitialIntegrationCredentials(
          spec.integrationId,
          bundleFetchOpts,
        );
        const source = createIntegrationCredentialsSource({
          integrationId: spec.integrationId,
          platformApiUrl: bundleFetchOpts.platformApiUrl,
          runToken: bundleFetchOpts.runToken,
          initialPayload: initial,
        });
        const credAdapter = createApiCallCredentialAdapter({
          source,
          authKey: spec.apiCall.authKey,
          authorizedUris: spec.apiCall.authorizedUris,
          ...(spec.apiCall.allowAllUris ? { allowAllUris: true } : {}),
        });
        const integ: ApiCallIntegrationConfig = {
          namespace: spec.namespace, // McpHost.register normalises it
          integrationId: spec.integrationId,
          fetchCredentials: credAdapter.fetchCredentials,
          refreshCredentials: credAdapter.refreshCredentials,
          // Resumable-upload protocols the manifest declared (plumbed via
          // the spawn resolver). When non-empty the factory also emits an
          // `api_upload` tool; the agent-side resolver drives it.
          ...(spec.apiCall.uploadProtocols && spec.apiCall.uploadProtocols.length > 0
            ? { uploadProtocols: spec.apiCall.uploadProtocols }
            : {}),
        };
        const defs = createApiCallToolDefs(integ, apiCallDeps);
        const pair = await createInProcessPair(defs, {
          serverInfo: { name: `appstrate-api-call-${spec.integrationId}`, version: "1" },
        });
        const wrapped = wrapClient(pair.client, { close: () => pair.close() });
        const sizeBefore = host.size();
        await host.register({
          namespace: spec.namespace,
          client: wrapped,
          trusted: true,
          allowedTools: defs.map((d) => d.descriptor.name),
          ...(intoNamespace ? { intoNamespace } : {}),
        });
        const count = host.size() - sizeBefore;
        clients.push(wrapped);
        logger.info("integration api_call registered (in-process)", {
          integrationId: spec.integrationId,
          namespace: intoNamespace ?? spec.namespace,
          authKey: spec.apiCall.authKey,
          attached: intoNamespace !== undefined,
          toolCount: count,
        });
        return count;
      };

      // Serverless integration (api_call-only, no MCP server) — the in-process
      // api_call server is its entire surface (registered as the primary).
      if (!spec.manifest.server) {
        const apiCallToolCount = await attachApiCall();
        spawned.push({
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          toolCount: apiCallToolCount,
        });
        continue;
      }
      const server = spec.manifest.server;

      // ─── Phase 7 — remote HTTP MCP path ───
      // When the manifest declares `server.type: "http"` the integration
      // is a managed remote MCP (e.g. Google's gmailmcp.googleapis.com).
      // No bundle to fetch, no runner to spawn, no MITM listener — the
      // sidecar opens a Streamable HTTP client directly and injects the
      // Bearer token per-request from the credentials source. Trade-off:
      // Phase 4 URL-envelope enforcement is N/A (we can't enforce per-tool
      // upstream URLs through a hosted MCP — the upstream decides).
      if (server.type === "http") {
        const { client, authKey } = await connectRemoteHttpIntegration(spec, bundleFetchOpts);
        const sizeBefore = host.size();
        const allocatedNs = await host.register({
          namespace: spec.namespace,
          client,
          // Phase 3 tool allowlist still applies — McpHost filters
          // tools/list before exposing them to the agent.
          allowedTools: spec.toolAllowlist,
        });
        const added = host.size() - sizeBefore;
        clients.push(client);
        // Attach the in-process api_call tool alongside the remote MCP's tools.
        const apiCallAdded = await attachApiCall(allocatedNs);
        spawned.push({
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          toolCount: added + apiCallAdded,
        });
        logger.info("integration registered (remote http)", {
          integrationId: spec.integrationId,
          namespace: spec.namespace,
          serverUrl: server.url,
          authKey,
          toolCount: added + apiCallAdded,
        });
        continue;
      }

      // ─── SINGLE spawn→connect→register pipeline (shared with connect-run) ──
      // MITM is created only when the CA came up AND this integration declared
      // `delivery.http`. `mitmSource` is returned so the connect-login hook
      // (run-start acquisition, below) drives `setSessionOutputs` on the same
      // source the MITM listener reads from.
      const wantsMitm =
        spec.httpDeliveryAuths !== undefined && Object.keys(spec.httpDeliveryAuths).length > 0;
      const {
        allocatedNs,
        mitmSource,
        toolCount: added,
        diagnosticId,
      } = await spawnAndConnectLocalIntegration({
        spec,
        runId,
        adapter,
        adapterCtx,
        host,
        bundleFetchOpts,
        ca: runCa,
        wantsMitm,
        ...(spec.toolUrlEnvelope ? { toolUrlEnvelope: spec.toolUrlEnvelope } : {}),
        allowedTools: spec.toolAllowlist,
        logLabel: "integration",
        clients,
        mitmListeners,
      });

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

      // Attach the in-process api_call tool alongside the spawned server's
      // native tools, under the same (allocated) namespace.
      const apiCallAdded = await attachApiCall(allocatedNs);

      spawned.push({
        integrationId: spec.integrationId,
        namespace: spec.namespace,
        toolCount: added + apiCallAdded,
      });
      logger.info("integration registered", {
        integrationId: spec.integrationId,
        namespace: spec.namespace,
        adapter: adapter.id,
        ...(diagnosticId ? { diagnosticId } : {}),
        toolCount: added + apiCallAdded,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ integrationId: spec.integrationId, error: msg });
      logger.warn("integration spawn failed", {
        integrationId: spec.integrationId,
        error: msg,
      });
    }
  }

  const tools = host.buildTools();
  return {
    host,
    tools,
    spawned,
    failed,
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
      // Close MITM listeners after the runtimes are torn down — listeners
      // hold open per-SNI Bun.serve sockets + cached leaf certs.
      for (const l of mitmListeners) {
        try {
          await l.close();
        } catch {
          // ignore — listener already torn down via SIGTERM
        }
      }
      if (runCa) {
        try {
          await rm(runCa.certHostPath, { force: true });
        } catch {
          // ignore — best-effort
        }
      }
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
  if (server.type === "http") {
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

  try {
    // Per-run CA — connect-login ALWAYS needs the MITM (the login secret is
    // substituted proxy-side; there is no plaintext-arg path), so unlike
    // `bootIntegrations` we let a CA failure throw rather than degrade.
    const ca = await prepareRunCa(runId, "afps-ca-connect-");
    runCaCertHostPath = ca.certHostPath;

    // Same spawn→connect→register pipeline the agent-run path uses, but
    // `allowedTools: []` (connect-run never serves an agent; register() is only
    // needed so `getUpstreamClient` resolves the login tool) and `wantsMitm`
    // forced on. The initial credential payload is a placeholder session with
    // an empty value — the real session is what `runConnectLogin` captures.
    const { allocatedNs, mitmSource } = await spawnAndConnectLocalIntegration({
      spec,
      runId,
      adapter,
      adapterCtx,
      host,
      bundleFetchOpts,
      ca,
      wantsMitm: true,
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
    if (runCaCertHostPath) {
      try {
        await rm(runCaCertHostPath, { force: true });
      } catch {
        // ignore — best-effort
      }
    }
  }
}
