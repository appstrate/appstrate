// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import type { ContainerOrchestrator } from "./interface.ts";
import type {
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarConfig,
  CleanupReport,
  StopResult,
} from "./types.ts";
import * as docker from "../docker.ts";
import { createNetworkWithPoolRetry } from "../docker-errors.ts";
import { logger } from "../../lib/logger.ts";
import * as sidecarPool from "../sidecar-pool.ts";
import { getSidecarImage, startSidecarAndHealthCheck } from "../sidecar-pool.ts";
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
      return new DockerWorkloadHandle(pooled, runId, "sidecar");
    }

    // 2. Fallback: fresh creation (~500-1500ms)
    const sidecarEnv: Record<string, string> = { PORT: "8080" };
    if (resolvedConfig.runToken) {
      sidecarEnv.RUN_TOKEN = resolvedConfig.runToken;
      sidecarEnv.PLATFORM_API_URL = resolvedConfig.platformApiUrl;
    }
    if (resolvedConfig.proxyUrl) {
      sidecarEnv.PROXY_URL = resolvedConfig.proxyUrl;
    }
    if (resolvedConfig.llm) {
      sidecarEnv.PI_BASE_URL = resolvedConfig.llm.baseUrl;
      sidecarEnv.PI_API_KEY = resolvedConfig.llm.apiKey;
      sidecarEnv.PI_PLACEHOLDER = resolvedConfig.llm.placeholder;
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

    await startSidecarAndHealthCheck(containerId);

    return new DockerWorkloadHandle(containerId, runId, "sidecar");
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
    await docker.stopContainer(handle.id, timeoutSeconds);
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
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
}
