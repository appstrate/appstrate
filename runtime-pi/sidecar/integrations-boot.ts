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
  createMcpHttpClient,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { planCaBundle, type CaBundle } from "@appstrate/connect/proxy-ca-planner";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";

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
} from "./integration-credentials-source.ts";
import { createApiCallCredentialAdapter } from "./api-call-credentials.ts";
import type { ApiCallIntegrationConfig } from "./mcp.ts";
import {
  selectIntegrationRuntimeAdapter,
  type IntegrationRuntimeAdapter,
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
  /** Tools registered on `host`, ready to merge into the sidecar's MCP surface. */
  tools: AppstrateToolDefinition[];
  /**
   * Per-integration `api_call` wiring (provider→integration unification).
   * One entry per spec that declared `apiCall` and whose agent selected
   * the `api_call` tool. `mountMcp` turns each into a
   * `{namespace}__api_call` tool. Empty when no integration opted in.
   */
  apiCallIntegrations: ApiCallIntegrationConfig[];
  /** Per-integration spawn outcome — useful for run-event observability. */
  spawned: Array<{ packageId: string; namespace: string; toolCount: number }>;
  /** Per-integration failures — emitted as warnings but do not abort boot. */
  failed: Array<{ packageId: string; error: string }>;
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
      typeof (s as IntegrationSpawnSpec).packageId === "string" &&
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
async function fetchBundleBytes(packageId: string, opts: BundleFetchOptions): Promise<Uint8Array> {
  const url = `${opts.platformApiUrl}/internal/integration-bundle/${packageId}`;
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
      detail || `Failed to fetch integration bundle for ${packageId}: HTTP ${res.status}`,
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
    throw new Error(`integration ${spec.packageId} declares server.type="http" but no server.url`);
  }

  const initial = await fetchInitialIntegrationCredentials(spec.packageId, bundleFetchOpts);

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
      `integration ${spec.packageId} server.type="http" has no auth with a resolvable delivery.http plan`,
    );
  }
  const authKey = pickedAuth.authKey;

  const source = createIntegrationCredentialsSource({
    packageId: spec.packageId,
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
 * Spawn every integration in parallel, register the surviving ones on a
 * shared {@link McpHost}, and return the materialised tool list. The
 * function never throws — per-integration failures are captured in
 * `result.failed` so a single broken integration doesn't black-hole the
 * entire run.
 */
export async function bootIntegrations(
  specs: IntegrationSpawnSpec[],
  bundleFetchOpts: BundleFetchOptions,
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
  const apiCallIntegrations: ApiCallIntegrationConfig[] = [];

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
    adapter = await selectIntegrationRuntimeAdapter();
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
  let runCaBundle: CaBundle | null = null;
  let runCaCertHostPath: string | null = null;
  let sharedMinter: CertMinter | null = null;
  if (mitmIntegrationCount > 0) {
    try {
      runCaBundle = await planCaBundle({
        runId,
        // /run is tmpfs on the sidecar image. The planner ONLY uses
        // tmpfsRoot for derived path strings inside the CaBundle return
        // value — it doesn't write anything itself. We materialise the
        // CA cert below at our own location.
        tmpfsRoot: "/run/afps",
        notAfterSeconds: 3600,
        generator: createOpensslCertGenerator(),
      });
      const caDir = await mkdtemp(join(tmpdir(), "afps-ca-"));
      runCaCertHostPath = join(caDir, "ca.pem");
      await writeFile(runCaCertHostPath, runCaBundle.pems.caCertPem, { mode: 0o444 });
      sharedMinter = createCertMinter({
        caCertPem: runCaBundle.pems.caCertPem,
        caKeyPem: runCaBundle.pems.caKeyPem,
      });
      logger.info("integration MITM CA minted", {
        runId,
        integrations: mitmIntegrationCount,
        caCertPath: runCaCertHostPath,
        notAfter: runCaBundle.notAfter,
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
      // build the credential adapter from a dedicated credentials source
      // so `mountMcp` can register `{namespace}__api_call`. A pure-proxy
      // integration (apiCall, no server) does ONLY this and skips spawn.
      if (spec.apiCall) {
        const initial = await fetchInitialIntegrationCredentials(spec.packageId, bundleFetchOpts);
        const source = createIntegrationCredentialsSource({
          packageId: spec.packageId,
          platformApiUrl: bundleFetchOpts.platformApiUrl,
          runToken: bundleFetchOpts.runToken,
          initialPayload: initial,
        });
        const credAdapter = createApiCallCredentialAdapter({
          source,
          authKey: spec.apiCall.authKey,
          authorizedUris: spec.apiCall.authorizedUris,
        });
        apiCallIntegrations.push({
          namespace: spec.namespace,
          packageId: spec.packageId,
          fetchCredentials: credAdapter.fetchCredentials,
          refreshCredentials: credAdapter.refreshCredentials,
        });
        logger.info("integration api_call registered", {
          packageId: spec.packageId,
          namespace: spec.namespace,
          authKey: spec.apiCall.authKey,
        });
      }

      // Serverless integration (apiCall-only, no MCP server) — nothing to
      // spawn; the api_call tool above is its entire surface.
      if (!spec.manifest.server) {
        spawned.push({
          packageId: spec.packageId,
          namespace: spec.namespace,
          toolCount: spec.apiCall ? 1 : 0,
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
        await host.register({
          namespace: spec.namespace,
          client,
          // Phase 3 tool allowlist still applies — McpHost filters
          // tools/list before exposing them to the agent.
          allowedTools: spec.toolAllowlist,
        });
        const added = host.size() - sizeBefore;
        clients.push(client);
        spawned.push({
          packageId: spec.packageId,
          namespace: spec.namespace,
          toolCount: added,
        });
        logger.info("integration registered (remote http)", {
          packageId: spec.packageId,
          namespace: spec.namespace,
          serverUrl: server.url,
          authKey,
          toolCount: added,
        });
        continue;
      }

      const wantsMitm =
        spec.httpDeliveryAuths !== undefined && Object.keys(spec.httpDeliveryAuths).length > 0;

      // Per-integration MITM listener (only when the CA came up + the
      // integration declared `delivery.http`).
      let listener: MitmListenerHandle | null = null;
      let mitmCtx: RuntimeMitmContext | null = null;
      if (
        wantsMitm &&
        sharedMinter !== null &&
        runCaBundle !== null &&
        runCaCertHostPath !== null
      ) {
        const initial = await fetchInitialIntegrationCredentials(spec.packageId, bundleFetchOpts);
        const source = createIntegrationCredentialsSource({
          packageId: spec.packageId,
          platformApiUrl: bundleFetchOpts.platformApiUrl,
          runToken: bundleFetchOpts.runToken,
          initialPayload: initial,
        });
        listener = createIntegrationMitmListener({
          caBundle: runCaBundle,
          minter: sharedMinter,
          credentials: source,
          // Adapter decides where the listener should bind so the
          // runner can reach it (0.0.0.0 for bridged networks, 127.0.0.1
          // when the runner shares the parent's NS).
          host: adapterCtx.listenerBindHost,
          // Phase 4 — narrow the per-request URL surface to the union
          // of agent-selected tool urlPatterns. `undefined` (legacy or
          // under-declared tools) leaves enforcement on the per-auth
          // `authorizedUris` only.
          ...(spec.toolUrlEnvelope ? { toolUrlEnvelope: spec.toolUrlEnvelope } : {}),
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
            logger.info("integration mitm event", {
              packageId: spec.packageId,
              ...safe,
            });
          },
        });
        await listener.ready;
        mitmListeners.push(listener);
        const port = listener.address().port;
        const runnerProxyUrl = adapterCtx.proxyUrlFor(port);
        mitmCtx = {
          proxyUrl: runnerProxyUrl,
          caCertHostPath: runCaCertHostPath,
        };
        logger.info("integration MITM listener ready", {
          packageId: spec.packageId,
          localUrl: listener.proxyUrl(),
          runnerProxyUrl,
        });
      }

      const bytes = await fetchBundleBytes(spec.packageId, bundleFetchOpts);
      const root = await extractBundle(bytes, spec.namespace);

      const spawnedIntegration = await adapter.spawn({
        runId,
        spec,
        bundleRoot: root,
        mitm: mitmCtx,
        onStderrLine: (line) => {
          logger.info("integration stderr", { packageId: spec.packageId, line });
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
      const sizeBefore = host.size();
      await host.register({
        namespace: spec.namespace,
        client: wrapped,
        // Niveau 2 Phase 3 — pass the agent-declared tool allowlist
        // through so McpHost.register filters `tools/list` to only the
        // tools the agent declared in its `dependencies.integrations[id].tools[]`.
        // `undefined` keeps the legacy "all tools allowed" semantics.
        ...(spec.toolAllowlist ? { allowedTools: spec.toolAllowlist } : {}),
      });
      const added = host.size() - sizeBefore;
      clients.push(wrapped);
      spawned.push({
        packageId: spec.packageId,
        namespace: spec.namespace,
        toolCount: added,
      });
      logger.info("integration registered", {
        packageId: spec.packageId,
        namespace: spec.namespace,
        adapter: adapter.id,
        ...(spawnedIntegration.diagnosticId
          ? { diagnosticId: spawnedIntegration.diagnosticId }
          : {}),
        toolCount: added,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ packageId: spec.packageId, error: msg });
      logger.warn("integration spawn failed", {
        packageId: spec.packageId,
        error: msg,
      });
    }
  }

  const tools = host.buildTools();
  return {
    host,
    tools,
    apiCallIntegrations,
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
      if (runCaCertHostPath) {
        try {
          await rm(runCaCertHostPath, { force: true });
        } catch {
          // ignore — best-effort
        }
      }
    },
  };
}
