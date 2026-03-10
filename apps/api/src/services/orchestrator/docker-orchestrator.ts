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
import * as sidecarPool from "../sidecar-pool.ts";
import { SIDECAR_IMAGE } from "../sidecar-pool.ts";

class DockerWorkloadHandle implements WorkloadHandle {
  constructor(
    readonly id: string,
    readonly executionId: string,
    readonly role: string,
  ) {}
}

export class DockerOrchestrator implements ContainerOrchestrator {
  async initialize(): Promise<void> {
    await sidecarPool.initSidecarPool();
  }

  async shutdown(): Promise<void> {
    await sidecarPool.shutdownSidecarPool();
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const { containers, networks } = await docker.cleanupOrphanedContainers();
    return { workloads: containers, isolationBoundaries: networks };
  }

  async createIsolationBoundary(executionId: string): Promise<IsolationBoundary> {
    const name = `appstrate-exec-${executionId}`;
    const id = await docker.createNetwork(name);
    return { id, name };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    await docker.removeNetwork(boundary.id);
  }

  async createSidecar(
    executionId: string,
    boundary: IsolationBoundary,
    config: SidecarConfig,
  ): Promise<WorkloadHandle> {
    const platformNetwork = await docker.detectPlatformNetwork();

    // Resolve platform API URL (Docker-specific: use network hostname if containerized)
    const resolvedPlatformApiUrl =
      config.platformApiUrl && platformNetwork
        ? `http://${platformNetwork.hostname}:${getEnv().PORT}`
        : config.platformApiUrl;

    const resolvedConfig = {
      executionToken: config.executionToken,
      platformApiUrl: resolvedPlatformApiUrl,
      proxyUrl: config.proxyUrl,
    };

    // 1. Try pool (fast path ~50-130ms)
    const pooled = await sidecarPool.acquireSidecar(
      executionId,
      boundary.id,
      resolvedConfig,
      platformNetwork,
    );
    if (pooled) {
      return new DockerWorkloadHandle(pooled, executionId, "sidecar");
    }

    // 2. Fallback: fresh creation (~500-1500ms)
    const sidecarEnv: Record<string, string> = { PORT: "8080" };
    if (resolvedConfig.executionToken) {
      sidecarEnv.EXECUTION_TOKEN = resolvedConfig.executionToken;
      sidecarEnv.PLATFORM_API_URL = resolvedConfig.platformApiUrl;
    }
    if (resolvedConfig.proxyUrl) {
      sidecarEnv.PROXY_URL = resolvedConfig.proxyUrl;
    }

    const containerId = await docker.createContainer(executionId, sidecarEnv, {
      image: SIDECAR_IMAGE,
      adapterName: "sidecar",
      memory: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      networkId: boundary.id,
      networkAlias: "sidecar",
      extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"],
      portBindings: { "8080/tcp": [{ HostPort: "0" }] },
      exposedPorts: { "8080/tcp": {}, "8081/tcp": {} },
    });

    if (platformNetwork) {
      await docker.connectContainerToNetwork(platformNetwork.networkId, containerId);
    }

    await docker.startContainer(containerId);
    const hostPort = await docker.getContainerHostPort(containerId, "8080/tcp");
    if (!hostPort) throw new Error("No host port mapped for fresh sidecar");
    await sidecarPool.waitForSidecarHealth(hostPort);

    return new DockerWorkloadHandle(containerId, executionId, "sidecar");
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const containerId = await docker.createContainer(spec.executionId, spec.env, {
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

    return new DockerWorkloadHandle(containerId, spec.executionId, spec.role);
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

  async stopByExecutionId(executionId: string, timeoutSeconds?: number): Promise<StopResult> {
    return docker.stopContainersByExecution(executionId, timeoutSeconds);
  }
}
