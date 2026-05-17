// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2c — bootstrap controller that wires every Phase 1.2a/b pure
 * module into a single runtime-pi entrypoint.
 *
 * Pipeline:
 *
 *   plan CA bundle ──► write tmpfs files ──► for each integration:
 *     ├─ validate + resolve manifest server
 *     ├─ buildSpawnCommand (node/bun/python/uv/binary/docker)
 *     ├─ buildProxyEnvInjection (6-tuple + 4 CA env vars)
 *     ├─ wrap in makeSupervisedSpawnFactory (Bun.spawn adapter)
 *     └─ register with spawnIntegrations (parallel init, ordered teardown)
 *
 *   Returns {@link IntegrationRuntimeController} carrying:
 *     - `running`        — list of {integrationId, namespace, pid, ...}
 *     - `shutdown()`     — torn-down idempotently
 *     - `refreshCredentials()` — fires SIGHUP to afpsAware integrations
 *     - `caBundle`       — for the MITM listener (1.2d) to load TLS material
 *
 * What this controller does NOT do (deferred to 1.2d):
 *   - Start the HTTPS MITM proxy listener (per-host SNI + re-encrypt).
 *   - Inject credentials into upstream requests — the listener owns that
 *     branch.
 *   - Wire MCP clients on top of the spawned children's stdio. That
 *     happens in McpHost (already exists); this controller just exposes
 *     the live stdio per integration via the `transport` callback.
 */

import * as fsPromises from "node:fs/promises";
import {
  buildProxyEnvInjection,
  buildSpawnCommand,
  bundleToFsWrites,
  planCaBundle,
  resolveIntegrationServer,
  spawnIntegrations,
  type CaBundle,
  type CertGenerator,
  type FsWriteEntry,
  type IntegrationOrchestrator,
  type IntegrationOrchestratorEvent,
  type IntegrationSpawnRequest,
  type ProxyEnvInjectionInput,
  type SignalDispatcher,
} from "@appstrate/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  makeSupervisedSpawnFactory,
  type SpawnIntegrationOptions,
  type SpawnedChildHandle,
} from "./integration-spawner.ts";
import {
  createIntegrationMitmListener,
  type MitmCredentialSource,
  type MitmListenerEvent,
  type MitmListenerHandle,
} from "./integration-mitm-listener.ts";
import { createCertMinter, type CertMinter } from "./integration-cert-minter.ts";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/** One integration to spawn — paired with its extracted bundle root. */
export interface IntegrationToSpawn {
  /** Stable id (DB packageId). */
  integrationId: string;
  /** Display namespace passed to McpHost (`@scope/name` last segment). */
  namespace: string;
  /** Validated manifest. */
  manifest: IntegrationManifest;
  /** Absolute path to the extracted bundle root. */
  bundleRoot: string;
  /**
   * Whether the integration declares afpsAware semantics. When true,
   * the controller will deliver SIGHUP on `refreshCredentials()` so
   * the MCP server can re-read its credential file in place. The
   * caller derives this from the registry metadata — it is not on
   * the manifest yet (spec §5.4.2 adds it in a follow-up).
   */
  afpsAware?: boolean;
  /**
   * Extra env to layer on top of the proxy 6-tuple (typically
   * credential delivery for afpsAware integrations or static env vars
   * the operator pinned).
   */
  extraEnv?: Record<string, string>;
  /** Override per-integration kill grace. */
  killTimeoutMs?: number;
  /**
   * Per-integration credential source — when set AND the controller's
   * `enableMitmListener` flag is on, the controller starts a dedicated
   * MITM listener for this integration and feeds its `http://…` URL
   * into the spawn's HTTPS_PROXY 6-tuple. Without this, the
   * integration spawns against the controller-level `proxyUrl`
   * (typically the shared sidecar forward-proxy — pre-1.2d behaviour).
   */
  credentialSource?: MitmCredentialSource;
}

export interface FsWriter {
  /** Write a single file atomically with the requested POSIX mode. */
  writeFile(path: string, content: string, mode: string): Promise<void>;
  /** Best-effort ensure the directory exists. */
  mkdir(path: string, mode?: string): Promise<void>;
}

export interface BootstrapIntegrationRuntimeOptions {
  /** Stable run id — embedded in the CA CN and the tmpfs subpath. */
  runId: string;
  /** Integrations to spawn (every integration's manifest must be pre-validated). */
  integrations: ReadonlyArray<IntegrationToSpawn>;
  /** Real X.509 generator. Production wires the openssl-backed one. */
  certGenerator: CertGenerator;
  /**
   * Proxy URL the integrations must talk through. Typically
   * `http://127.0.0.1:<port>` of the in-container MITM listener.
   * Required even when the listener isn't running yet (1.2d) —
   * subprocesses fail-closed when the proxy is unreachable.
   */
  proxyUrl: string;
  /** Hosts the subprocess should NOT proxy (e.g. platform sink). */
  noProxy?: readonly string[];
  /** Optional CN/SAN seed for the leaf cert. Defaults: CN="localhost", no extra SANs. */
  serverCommonName?: string;
  serverSans?: readonly string[];
  /** Cert validity. Default 1h (matches max run duration). */
  notAfterSeconds?: number;
  /** Where the CA files land. Default `/run/afps`. */
  tmpfsRoot?: string;
  /** Injectable fs. Production wires {@link createDefaultFsWriter}. */
  fs?: FsWriter;
  /** Injectable spawn options (forwarded into the supervisor factory). */
  spawnOptions?: Pick<SpawnIntegrationOptions, "envPassthrough" | "spawn">;
  /** Telemetry sink. */
  onEvent?: (event: IntegrationOrchestratorEvent) => void;
  /** Custom clock (passed to planCaBundle for `generatedAt`). */
  now?: () => Date;
  /**
   * When `true`, the controller starts one {@link createIntegrationMitmListener}
   * per integration that supplied a `credentialSource`. The listener's URL
   * overrides the controller-level `proxyUrl` for that integration's spawn
   * env. Default `false` keeps 1.2c behaviour (no MITM, integrations share
   * the caller-supplied `proxyUrl`).
   *
   * The same per-run CA bundle drives every listener — the run CA must
   * already be in the integration's trust store via {@link buildProxyEnvInjection}
   * so the minted leaf certs validate inside the subprocess.
   */
  enableMitmListener?: boolean;
  /**
   * Maximum number of distinct SNI hosts a single listener will cache
   * leaf certs for. Defaults to 256 (one per upstream host the
   * integration calls — typical real-world bound is much smaller).
   */
  mitmListenerHostCapacity?: number;
  /** Telemetry sink for listener events (per-integration callbacks share this). */
  onMitmEvent?: (integrationId: string, event: MitmListenerEvent) => void;
}

export interface IntegrationRuntimeController {
  /** Per-run CA bundle the MITM listener loads on startup. */
  readonly caBundle: CaBundle;
  /** Underlying orchestrator. */
  readonly orchestrator: IntegrationOrchestrator;
  /** Convenience view of the running children's live state. */
  readonly running: ReadonlyArray<RunningIntegrationView>;
  /** Look up the live SpawnedChildHandle for an integration. */
  childFor(integrationId: string): SpawnedChildHandle | undefined;
  /** Look up the MITM listener handle for an integration, if any. */
  listenerFor(integrationId: string): MitmListenerHandle | undefined;
  /** Re-fire SIGHUP at every afpsAware integration. */
  refreshCredentials(targets?: ReadonlyArray<string>): Promise<{
    sent: string[];
    skipped: string[];
  }>;
  /** Stop every integration; idempotent. */
  shutdown(): Promise<void>;
}

export interface RunningIntegrationView {
  integrationId: string;
  namespace: string;
  pid?: number;
  initialised: boolean;
}

// ─────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────

/**
 * One-shot bootstrap. The returned controller stays live until the
 * caller invokes `shutdown()`.
 *
 * Order of operations is significant:
 *   1. Plan the CA + write tmpfs FIRST — so child env vars point at a
 *      valid file the moment subprocesses spawn.
 *   2. Spawn integrations only after the CA is on disk. The reverse
 *      order has a race window where a fast-starting MCP server makes
 *      its first HTTPS call before the CA file lands.
 *
 * On any step's failure the controller leaves nothing behind — the CA
 * tmpfs is wiped, no children are started, and the error propagates.
 */
export async function bootstrapIntegrationRuntime(
  options: BootstrapIntegrationRuntimeOptions,
): Promise<IntegrationRuntimeController> {
  const fs = options.fs ?? createDefaultFsWriter();
  const tmpfsRoot = options.tmpfsRoot ?? "/run/afps";

  // ─── Step 1: generate + materialise the CA bundle ───
  const caBundle = await planCaBundle({
    runId: options.runId,
    tmpfsRoot,
    ...(options.serverCommonName ? { serverCommonName: options.serverCommonName } : {}),
    ...(options.serverSans ? { serverSans: options.serverSans } : {}),
    notAfterSeconds: options.notAfterSeconds ?? 3600,
    generator: options.certGenerator,
    ...(options.now ? { now: options.now } : {}),
  });

  await fs.mkdir(tmpfsRoot, "0700");
  const writes: FsWriteEntry[] = bundleToFsWrites(caBundle);
  for (const w of writes) {
    await fs.writeFile(w.path, w.content, w.mode);
  }

  // ─── Step 2a: bring up per-integration MITM listeners (optional) ───
  const listeners = new Map<string, MitmListenerHandle>();
  let sharedMinter: CertMinter | null = null;
  if (options.enableMitmListener) {
    sharedMinter = createCertMinter({
      caCertPem: caBundle.pems.caCertPem,
      caKeyPem: caBundle.pems.caKeyPem,
      ...(options.mitmListenerHostCapacity
        ? { cacheCapacity: options.mitmListenerHostCapacity }
        : {}),
    });
    for (const integ of options.integrations) {
      if (!integ.credentialSource) continue;
      const listener = createIntegrationMitmListener({
        caBundle,
        minter: sharedMinter,
        credentials: integ.credentialSource,
        ...(options.onMitmEvent
          ? {
              onEvent: (event) => options.onMitmEvent?.(integ.integrationId, event),
            }
          : {}),
      });
      await listener.ready;
      listeners.set(integ.integrationId, listener);
    }
  }

  // ─── Step 2b: spawn every integration in parallel ───
  const live = new Map<string, SpawnedChildHandle>();
  const spawnRequests: IntegrationSpawnRequest[] = [];

  for (const integ of options.integrations) {
    const target = resolveIntegrationServer(integ.manifest.server, integ.bundleRoot);
    const effectiveProxyUrl = listeners.get(integ.integrationId)?.proxyUrl() ?? options.proxyUrl;
    const proxyEnv = buildProxyEnvInjection({
      proxyUrl: effectiveProxyUrl,
      caCertPath: caBundle.caCertPath,
      ...(options.noProxy ? { noProxy: options.noProxy } : {}),
    } satisfies ProxyEnvInjectionInput);

    const plan = buildSpawnCommand(target, {
      extraEnv: { ...proxyEnv, ...(integ.extraEnv ?? {}) },
    });

    const factory = makeSupervisedSpawnFactory(plan, {
      ...(options.spawnOptions?.envPassthrough
        ? { envPassthrough: options.spawnOptions.envPassthrough }
        : {}),
      ...(options.spawnOptions?.spawn ? { spawn: options.spawnOptions.spawn } : {}),
      ...(integ.killTimeoutMs !== undefined ? { killTimeoutMs: integ.killTimeoutMs } : {}),
      onSpawn: (handle) => {
        live.set(integ.integrationId, handle);
      },
    });

    spawnRequests.push({
      integrationId: integ.integrationId,
      namespace: integ.namespace,
      afpsAware: integ.afpsAware === true,
      spawn: factory,
    });
  }

  // SignalDispatcher backed by the live children. SIGHUP is the only
  // signal §5.4.2 calls out for cred-refresh; SIGTERM is reserved for
  // the orchestrator's shutdown path.
  const signaller: SignalDispatcher = {
    async signal(integrationId, signal) {
      const handle = live.get(integrationId);
      if (!handle) return false;
      try {
        handle.subprocess.kill(signal);
        return true;
      } catch {
        // Subprocess already gone — treat as "not running".
        return false;
      }
    },
  };

  let orchestrator: IntegrationOrchestrator;
  try {
    orchestrator = await spawnIntegrations(spawnRequests, {
      signaller,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
  } catch (err) {
    // Tear down the listeners + wipe CA tmpfs — nothing's using them now.
    for (const listener of listeners.values()) {
      try {
        await listener.close();
      } catch {
        // ignore
      }
    }
    await safeRm(fs, writes);
    throw err;
  }

  // ─── Controller façade ───
  const controller: IntegrationRuntimeController = {
    caBundle,
    orchestrator,
    get running() {
      return orchestrator.running.map((r) => {
        const handle = live.get(r.integrationId);
        return {
          integrationId: r.integrationId,
          namespace: r.namespace,
          initialised: r.initialised,
          ...(handle?.pid !== undefined ? { pid: handle.pid } : {}),
        };
      });
    },
    childFor(integrationId) {
      return live.get(integrationId);
    },
    listenerFor(integrationId) {
      return listeners.get(integrationId);
    },
    async refreshCredentials(targets) {
      return orchestrator.signalCredentialRefresh(targets);
    },
    async shutdown() {
      try {
        await orchestrator.shutdown();
      } finally {
        for (const listener of listeners.values()) {
          try {
            await listener.close();
          } catch {
            // ignore
          }
        }
        listeners.clear();
        await safeRm(fs, writes);
      }
    },
  };

  return controller;
}

// ─────────────────────────────────────────────
// Default FsWriter (node:fs)
// ─────────────────────────────────────────────

/**
 * Production-grade fs writer using `node:fs/promises`. Mode is the
 * 4-digit octal string emitted by the planner (`"0444"`, `"0400"`).
 */
export function createDefaultFsWriter(): FsWriter {
  return {
    async writeFile(path, content, mode) {
      await fsPromises.writeFile(path, content, {
        encoding: "utf-8",
        mode: parseOctalMode(mode),
      });
      // Re-chmod in case the umask masked the requested bits on creation.
      await fsPromises.chmod(path, parseOctalMode(mode));
    },
    async mkdir(path, mode) {
      await fsPromises.mkdir(path, {
        recursive: true,
        ...(mode ? { mode: parseOctalMode(mode) } : {}),
      });
    },
  };
}

function parseOctalMode(mode: string): number {
  // Planner emits 4-digit strings like "0444" — strip the leading zero
  // for parseInt(8) and validate the result is in the umask-safe range.
  const cleaned = mode.startsWith("0") ? mode.slice(1) : mode;
  const n = parseInt(cleaned, 8);
  if (Number.isNaN(n) || n < 0 || n > 0o7777) {
    throw new Error(`parseOctalMode: '${mode}' is not a valid 4-digit octal mode`);
  }
  return n;
}

async function safeRm(fs: FsWriter, writes: ReadonlyArray<FsWriteEntry>): Promise<void> {
  // Use fs.rm/unlink directly via node:fs to avoid widening the FsWriter
  // surface — the unlink path is only needed for cleanup, and going
  // through node:fs keeps test-injected writers focused on the happy path.
  for (const w of writes) {
    try {
      await fsPromises.rm(w.path, { force: true });
    } catch {
      // ignore — caller surface tolerates partial cleanup.
    }
  }
  void fs; // mark as intentionally unused in the cleanup path
}
