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
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { planCaBundle, type CaBundle } from "@appstrate/connect/integrations";

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
 * Per-integration spec produced by the platform launcher. The launcher
 * resolves the agent's `dependencies.integrations` → `applicationPackages`
 * → `integration_connections` chain so the sidecar receives a flat,
 * ready-to-spawn payload (manifest + live credentials). Bundle bytes
 * are fetched separately via the internal endpoint (#bundle size limit).
 */
export interface IntegrationSpawnSpec {
  /** Package id (e.g. `@appstrate/gmail-mcp`). */
  packageId: string;
  /** McpHost namespace — typically the package's slug portion. */
  namespace: string;
  /** Validated integration manifest (server, transport, auths). */
  manifest: IntegrationManifestLite;
  /**
   * Resolved env vars to set on the spawned subprocess. Built from
   * `manifest.auths.{key}.delivery.env`, with values taken from the live
   * (already-refreshed) credentials. Sensitive: never logged.
   */
  spawnEnv: Record<string, string>;
  /**
   * Phase 1.5 — per-auth `delivery.http` metadata. Presence (with at
   * least one entry) tells the sidecar to take the MITM path for this
   * integration: start a per-integration HTTPS listener, mint a CA
   * bundle, hand the runner `HTTPS_PROXY` + `*_CA_*` env vars, and let
   * the listener inject the live header per `delivery.http` spec.
   * Absent / empty = stay on the env-delivery-only path.
   *
   * Structural mirror of `IntegrationSpawnSpec.httpDeliveryAuths` in
   * `@appstrate/core/sidecar-types` — the wire payload is the same shape.
   */
  httpDeliveryAuths?: Record<
    string,
    {
      authType: string;
      headerName: string;
      headerPrefix: string;
      value: string;
      allowServerOverride: boolean;
      authorizedUris: readonly string[];
      expiresAtEpochMs: number | null;
    }
  >;
  /**
   * Niveau 2 Phase 3 — agent-declared MCP tool allowlist. Passed straight
   * through to `McpHost.register({ allowedTools })` so the agent's LLM
   * only sees the tools its manifest declared. `undefined` keeps the
   * legacy "all tools allowed" semantics. Structural mirror of
   * `IntegrationSpawnSpec.toolAllowlist` in `@appstrate/core/sidecar-types`.
   */
  toolAllowlist?: readonly string[];
}

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

/**
 * Minimal subset of the integration manifest that this boot module
 * needs. Mirrors `@appstrate/core/integration`'s `IntegrationManifest`
 * but flattened to the fields we read here — the sidecar avoids importing
 * the full Zod schema bundle.
 */
export interface IntegrationManifestLite {
  name: string;
  version: string;
  server: {
    type: string;
    entryPoint?: string;
  };
  transport?: { type: string };
}

export interface BootIntegrationsResult {
  host: McpHost;
  /** Tools registered on `host`, ready to merge into the sidecar's MCP surface. */
  tools: AppstrateToolDefinition[];
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
