// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
import type {
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import * as docker from "../docker.ts";
import { createNetworkWithPoolRetry } from "../docker-errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_MEMORY_BYTES, SIDECAR_NANO_CPUS } from "./constants.ts";

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
   * path. Added in {@link stopWorkload}, consumed by the watcher, and
   * defensively cleared in {@link removeWorkload} / {@link shutdown}.
   */
  private expectedSidecarExits = new Set<string>();

  async initialize(): Promise<void> {
    // Ensure runtime images are present (may have been pruned by host cleanup).
    // Use ensureImage (not pullImage) so locally-built / custom-tagged images
    // aren't re-pulled. Pulling once at boot amortises a 20–45 s cold pull off
    // the first run's critical path — the agent's own Bun cold start (~1 s)
    // already masks the warm-image sidecar boot, so a pre-warmed pool buys
    // nothing extra on the user-visible latency.
    const env = getEnv();
    const [, , , egressId] = await Promise.all([
      docker.ensureImage(env.PI_IMAGE),
      docker.ensureImage(env.SIDECAR_IMAGE),
      docker.detectPlatformNetwork(),
      docker.createNetwork("appstrate-egress"),
    ]);
    this.egressNetworkId = egressId;
  }

  async shutdown(): Promise<void> {
    if (this.egressNetworkId) {
      await docker.removeNetwork(this.egressNetworkId).catch(() => {});
      this.egressNetworkId = null;
    }
    // Drop any residual entries — long-lived API processes accumulate
    // one per timed-out / aborted run because `removeWorkload` always
    // re-adds after `stopWorkload` consumed the watcher's match.
    this.expectedSidecarExits.clear();
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
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    const env = getEnv();
    const [platformApiUrl, platformNetwork] = await Promise.all([
      this.resolvePlatformApiUrl(),
      docker.detectPlatformNetwork(),
    ]);

    const sidecarEnv: Record<string, string> = {
      PORT: "8080",
      ...pickOperatorSidecarEnv(),
      RUN_TOKEN: spec.runToken,
      // Phase 1.4 — exposed so the sidecar can stamp `appstrate.run=<runId>`
      // on integration runner containers it spawns, letting the platform's
      // orphan reaper match them back to the parent run.
      RUN_ID: runId,
      PLATFORM_API_URL: platformApiUrl,
    };
    if (spec.proxyUrl) sidecarEnv.PROXY_URL = spec.proxyUrl;
    if (spec.modelContextWindow != null) {
      sidecarEnv.MODEL_CONTEXT_WINDOW = String(spec.modelContextWindow);
    }
    if (spec.modelMaxTokens != null) {
      sidecarEnv.MODEL_MAX_TOKENS = String(spec.modelMaxTokens);
    }
    if (spec.llm) {
      if (spec.llm.authMode === "oauth") {
        // OAuth wire format: ship the LlmProxyOauthConfig as JSON so
        // server.ts parses it into config.llm at boot. Without this,
        // /llm/* returns 503 "LLM proxy not configured".
        sidecarEnv.PI_LLM_OAUTH_CONFIG_JSON = JSON.stringify(spec.llm);
      } else {
        sidecarEnv.PI_BASE_URL = spec.llm.baseUrl;
        sidecarEnv.PI_API_KEY = spec.llm.apiKey;
        sidecarEnv.PI_PLACEHOLDER = spec.llm.placeholder;
      }
    }
    // Phase 1.4 — integrations the sidecar will spawn + multiplex onto
    // the agent's MCP surface. Each entry carries the bundle bytes +
    // resolved spawn env (with live OAuth tokens / API keys).
    if (spec.integrations && spec.integrations.length > 0) {
      sidecarEnv.INTEGRATIONS_TO_SPAWN_JSON = JSON.stringify(spec.integrations);
    }
    // The sidecar selects its integration runtime purely from this var (no
    // auto-detection). Pin it to mirror this orchestrator's RUN_ADAPTER so a
    // containerized run spawns its integrations as containers too. Respect an
    // explicit operator override carried in from the environment.
    sidecarEnv.INTEGRATION_RUNTIME_ADAPTER = process.env.INTEGRATION_RUNTIME_ADAPTER ?? "docker";
    // P4 — connect-run mode. When set, the sidecar runs `runConnectOnce`
    // against this single integration and exits (no agent /mcp server).
    if (spec.connectLoginSpec) {
      sidecarEnv.CONNECT_LOGIN_JSON = JSON.stringify(spec.connectLoginSpec);
    }

    // Create sidecar on egress network (primary) so it has DNS + internet.
    // Then connect to run network (internal) with "sidecar" alias for agent DNS.
    //
    // When the run declares AFPS integrations, the sidecar needs to spawn
    // per-integration runner containers (`appstrate-mcp-runner-{node,python,
    // binary}`). It shells out to the Docker daemon via the mounted socket
    // + `docker-cli` baked into the sidecar image. Running as root is the
    // simplest portable way to access the socket (group GIDs vary across
    // hosts: Docker Desktop on macOS exposes a 0-owned socket, Linux a
    // `docker`-group one, rootless Docker uses the calling UID). We only
    // grant it when the run actually has integrations — otherwise we keep
    // the sidecar locked down with the image's default `nobody:nobody`.
    const hasIntegrations = spec.integrations !== undefined && spec.integrations.length > 0;
    const containerId = await docker.createContainer(runId, sidecarEnv, {
      image: env.SIDECAR_IMAGE,
      adapterName: "sidecar",
      memory: SIDECAR_MEMORY_BYTES,
      nanoCpus: SIDECAR_NANO_CPUS,
      networkId: this.egressNetworkId!,
      extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"],
      ...(hasIntegrations
        ? {
            binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            user: "0:0",
          }
        : {}),
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
    // Sidecar exit detection still happens loudly: a non-blocking watcher
    // races `waitForExit` against the run. If the sidecar dies before MCP
    // connects, the watcher logs `exitCode` + buffered stderr/stdout, so
    // operators see "sidecar exited 1 (npm not found)" rather than the
    // agent's eventual "deadline exceeded" hand-wave.
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
          // 2s window: on a busy Docker daemon the multiplexed-stream
          // parser may not have emitted any complete lines under 500ms
          // after the exit, which defeats the purpose of the watcher.
          let tail = "";
          try {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 2_000);
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
    // `skipSidecar` runs have no egress proxy, so the agent must reach the
    // upstream LLM + platform sink itself. Give it the same network setup
    // as the sidecar (egress network primary + host-gateway / platform net)
    // instead of the internal-only isolation boundary, which has no route
    // out and would fail the agent's first `emitRuntimeReady` POST.
    const platformNetwork = spec.egress ? await docker.detectPlatformNetwork() : null;

    const containerId = await docker.createContainer(spec.runId, spec.env, {
      image: spec.image,
      adapterName: spec.role,
      memory: spec.resources.memoryBytes,
      nanoCpus: spec.resources.nanoCpus,
      pidsLimit: spec.resources.pidsLimit,
      networkId: spec.egress ? this.egressNetworkId! : boundary.id,
      networkAlias: spec.role,
      ...(spec.egress
        ? { extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"] }
        : {}),
    });

    if (spec.egress && platformNetwork) {
      await docker.connectContainerToNetwork(platformNetwork.networkId, containerId);
    }

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
    // No `expectedSidecarExits.add` here: by the time we're removing the
    // container its `waitForExit` watcher has already resolved (either
    // through the happy path or via `stopWorkload`'s suppression). Adding
    // again would leak one string per run for the process lifetime.
    await docker.removeContainer(handle.id);
    if (handle.role === "sidecar") this.expectedSidecarExits.delete(handle.id);
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
