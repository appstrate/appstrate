// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
import type {
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarConfig,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import * as docker from "../docker.ts";
import { createNetworkWithPoolRetry } from "../docker-errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import * as sidecarPool from "../sidecar-pool.ts";
import { getSidecarImage } from "../sidecar-pool.ts";
import {
  SIDECAR_MEMORY_BYTES,
  SIDECAR_NANO_CPUS,
  SIDECAR_EXPOSED_PORTS,
  SIDECAR_PORT_BINDINGS,
} from "./constants.ts";

class DockerWorkloadHandle implements WorkloadHandle {
  constructor(
    readonly id: string,
    readonly runId: string,
    readonly role: string,
  ) {}
}

export class DockerOrchestrator implements ContainerOrchestrator {
  private egressNetworkId: string | null = null;
  /**
   * Set of sidecar container IDs whose exit is expected (run is being
   * torn down). The {@link watchSidecarExit} watcher consults this set
   * to suppress the "sidecar exited unexpectedly" log on the cleanup
   * path. Removed in {@link stopWorkload} / {@link removeWorkload}.
   */
  private expectedSidecarExits = new Set<string>();

  async initialize(): Promise<void> {
    // Ensure runtime images are present (may have been pruned by host cleanup).
    // Use ensureImage (not pullImage) so locally-built / custom-tagged images aren't re-pulled.
    const env = getEnv();
    await Promise.all([docker.ensureImage(env.PI_IMAGE), docker.ensureImage(env.SIDECAR_IMAGE)]);

    const [, , egressId] = await Promise.all([
      sidecarPool.initSidecarPool(),
      docker.detectPlatformNetwork(),
      docker.createNetwork("appstrate-egress"),
    ]);
    this.egressNetworkId = egressId;
  }

  async shutdown(): Promise<void> {
    await sidecarPool.shutdownSidecarPool();
    if (this.egressNetworkId) {
      await docker.removeNetwork(this.egressNetworkId).catch(() => {});
      this.egressNetworkId = null;
    }
  }

  async ensureImages(images: string[]): Promise<void> {
    await Promise.all(images.map((image) => docker.ensureImage(image)));
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const { containers, networks } = await docker.cleanupOrphanedContainers();
    return { workloads: containers, isolationBoundaries: networks };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    const name = `${docker.EXEC_NETWORK_PREFIX}${runId}`;
    const id = await createNetworkWithPoolRetry(
      () => docker.createNetwork(name, { internal: true }),
      () => docker.cleanupOrphanedRunNetworks(),
      logger,
    );
    return { id, name };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    await docker.removeNetwork(boundary.id);
  }

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    config: SidecarConfig,
  ): Promise<WorkloadHandle> {
    const platformNetwork = await docker.detectPlatformNetwork();

    // Resolve platform API URL. When we can talk to the platform over its
    // Docker network, always prefer that: it keeps credential traffic inside
    // the Docker bridge (no NAT, no public hop, no TLS overhead) and survives
    // Coolify redeploys that rename the platform container.
    const resolvedPlatformApiUrl = platformNetwork
      ? `http://${platformNetwork.hostname}:${getEnv().PORT}`
      : config.platformApiUrl;

    const resolvedConfig = {
      runToken: config.runToken,
      platformApiUrl: resolvedPlatformApiUrl,
      proxyUrl: config.proxyUrl,
      llm: config.llm,
    };

    // 1. Try pool (fast path ~50-130ms)
    const pooled = await sidecarPool.acquireSidecar(
      runId,
      boundary.id,
      resolvedConfig,
      platformNetwork,
    );
    if (pooled) {
      // Connect pooled sidecar to egress network (internet access)
      if (this.egressNetworkId) {
        await docker.connectContainerToNetwork(this.egressNetworkId, pooled);
      }
      // Pool sidecars are already health-checked at pool creation, but
      // they still need an exit watcher: a sidecar that crashes mid-run
      // (e.g. OOM under heavy provider_call) must surface loudly rather
      // than letting the agent's next MCP request time out silently.
      this.watchSidecarExit(runId, pooled);
      return new DockerWorkloadHandle(pooled, runId, "sidecar");
    }

    // 2. Fallback: fresh creation (~500-1500ms)
    // Operator-tunable sidecar caps are read from the API host's
    // process.env and forwarded into the spawned container so
    // overrides apply to fresh sidecars (pooled sidecars pick up the
    // value at pool creation time — see sidecar-pool.ts).
    const sidecarEnv: Record<string, string> = { PORT: "8080", ...pickOperatorSidecarEnv() };
    if (resolvedConfig.runToken) {
      sidecarEnv.RUN_TOKEN = resolvedConfig.runToken;
      sidecarEnv.PLATFORM_API_URL = resolvedConfig.platformApiUrl;
    }
    if (resolvedConfig.proxyUrl) {
      sidecarEnv.PROXY_URL = resolvedConfig.proxyUrl;
    }
    if (resolvedConfig.llm) {
      if (resolvedConfig.llm.authMode === "oauth") {
        // OAuth wire format: ship the LlmProxyOauthConfig as JSON, matching
        // process-orchestrator. server.ts in the sidecar parses it into
        // config.llm at boot so handleOauthLlmRequest can serve /llm/* on the
        // fresh-creation path without a /configure round-trip. Without this,
        // /llm/* returns 503 "LLM proxy not configured" whenever the pool is
        // empty / disabled / exhausted (cold start, SIDECAR_POOL_SIZE=0, …).
        sidecarEnv.PI_LLM_OAUTH_CONFIG_JSON = JSON.stringify(resolvedConfig.llm);
      } else {
        sidecarEnv.PI_BASE_URL = resolvedConfig.llm.baseUrl;
        sidecarEnv.PI_API_KEY = resolvedConfig.llm.apiKey;
        sidecarEnv.PI_PLACEHOLDER = resolvedConfig.llm.placeholder;
      }
    }

    // Create sidecar on egress network (primary) so it has DNS + internet.
    // Then connect to run network (internal) with "sidecar" alias for agent DNS.
    const containerId = await docker.createContainer(runId, sidecarEnv, {
      image: getSidecarImage(),
      adapterName: "sidecar",
      memory: SIDECAR_MEMORY_BYTES,
      nanoCpus: SIDECAR_NANO_CPUS,
      networkId: this.egressNetworkId!,
      extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"],
      portBindings: SIDECAR_PORT_BINDINGS,
      exposedPorts: SIDECAR_EXPOSED_PORTS,
    });

    // Connect to run network (agent reaches sidecar via "sidecar" DNS alias)
    await docker.connectContainerToNetwork(boundary.id, containerId, ["sidecar"]);

    if (platformNetwork) {
      await docker.connectContainerToNetwork(platformNetwork.networkId, containerId);
    }

    // #406 — parallel boot. Start the sidecar but DO NOT block on its
    // `/health` here. The agent (started in parallel by pi.ts) drives
    // a retrying MCP handshake against `sidecar:8080/mcp`, which absorbs:
    //   - ECONNREFUSED while the sidecar is wiring its listener
    //   - ENOTFOUND while the Docker bridge propagates the "sidecar" alias
    //   - ECONNRESET on the pool's `/configure` warm-path race
    // Sidecar exit detection still happens loudly: a non-blocking
    // watcher races `waitForExit` against the run. If the sidecar dies
    // before MCP connects, the watcher logs `exitCode` + buffered
    // stderr/stdout, so operators see "sidecar exited 1 (npm not found)"
    // rather than the agent's eventual "deadline exceeded" hand-wave.
    await docker.startContainer(containerId);
    this.watchSidecarExit(runId, containerId);

    return new DockerWorkloadHandle(containerId, runId, "sidecar");
  }

  /**
   * Non-blocking watcher: race the sidecar's exit against the run. The
   * caller never awaits this — its only job is to surface a sidecar
   * that crashes mid-handshake with a structured log line carrying the
   * exit code + a snippet of the container's stderr. Without it, a
   * dead-on-arrival sidecar manifests as an agent-side "MCP connect
   * deadline exceeded after 30000ms" 30s later, with no platform-side
   * evidence of root cause.
   *
   * Best-effort: errors are swallowed (the orchestrator's main lifecycle
   * is the source of truth for failure surfaces). Errors here would only
   * add noise to a path that's already going to fail loudly somewhere.
   */
  private watchSidecarExit(runId: string, containerId: string): void {
    void (async () => {
      try {
        const exitCode = await docker.waitForExit(containerId);
        // Cleanup path stops/removes the sidecar after the run terminates
        // — those exits are expected and never indicate a problem.
        if (this.expectedSidecarExits.has(containerId)) {
          this.expectedSidecarExits.delete(containerId);
          return;
        }
        if (exitCode !== 0) {
          // Pull a short tail of logs — best-effort, bounded so we
          // don't keep a generator open forever if logs are streamed.
          let tail = "";
          try {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 500);
            const lines: string[] = [];
            for await (const line of docker.streamLogs(containerId, abort.signal)) {
              lines.push(line);
              if (lines.length >= 30) break;
            }
            clearTimeout(timer);
            tail = lines.slice(-30).join("\n");
          } catch {
            // Swallow — diagnostic is best-effort.
          }
          logger.error("Sidecar exited before run completed", {
            runId,
            containerId,
            exitCode,
            ...(tail ? { tail } : {}),
          });
        }
      } catch (err) {
        logger.debug("Sidecar exit watcher errored", {
          runId,
          containerId,
          error: getErrorMessage(err),
        });
      }
    })();
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const containerId = await docker.createContainer(spec.runId, spec.env, {
      image: spec.image,
      adapterName: spec.role,
      memory: spec.resources.memoryBytes,
      nanoCpus: spec.resources.nanoCpus,
      pidsLimit: spec.resources.pidsLimit,
      networkId: boundary.id,
      networkAlias: spec.role,
    });

    if (spec.files && spec.files.items.length > 0) {
      await docker.injectFiles(containerId, spec.files.items, spec.files.targetDir);
    }

    return new DockerWorkloadHandle(containerId, spec.runId, spec.role);
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    await docker.startContainer(handle.id);
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds?: number): Promise<void> {
    if (handle.role === "sidecar") this.expectedSidecarExits.add(handle.id);
    await docker.stopContainer(handle.id, timeoutSeconds);
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    if (handle.role === "sidecar") this.expectedSidecarExits.add(handle.id);
    await docker.removeContainer(handle.id);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    return docker.waitForExit(handle.id);
  }

  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    yield* docker.streamLogs(handle.id, signal);
  }

  async stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult> {
    return docker.stopContainersByRun(runId, timeoutSeconds);
  }

  /**
   * Resolve the base URL the agent container uses to reach the platform API.
   * Identical logic to {@link createSidecar} — prefer the platform's own
   * Docker network (keeps traffic on the bridge), fall back to
   * `PLATFORM_API_URL` env, finally to `host.docker.internal` for local dev.
   */
  async resolvePlatformApiUrl(): Promise<string> {
    const env = getEnv();
    const platformNetwork = await docker.detectPlatformNetwork();
    if (platformNetwork) return `http://${platformNetwork.hostname}:${env.PORT}`;
    if (env.PLATFORM_API_URL) return env.PLATFORM_API_URL;
    return `http://host.docker.internal:${env.PORT}`;
  }
}
