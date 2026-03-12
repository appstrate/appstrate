import { logger } from "../lib/logger.ts";
import {
  createContainer,
  startContainer,
  removeContainer,
  connectContainerToNetwork,
  getContainerHostPort,
  getDockerHostAddress,
  createNetwork,
  removeNetwork,
} from "./docker.ts";
import {
  SIDECAR_MEMORY_BYTES,
  SIDECAR_NANO_CPUS,
  SIDECAR_EXPOSED_PORTS,
} from "./orchestrator/constants.ts";
export const SIDECAR_IMAGE = "appstrate-sidecar:latest";
const POOL_SIZE = 2;
const HEALTH_CHECK_RETRIES = 15;
const HEALTH_CHECK_DELAYS_MS = [
  25, 50, 50, 100, 100, 200, 200, 400, 400, 400, 400, 400, 400, 400, 400,
];

interface PooledSidecar {
  containerId: string;
  hostPort: number;
  configSecret: string;
}

const pool: PooledSidecar[] = [];
let standbyNetworkId: string | undefined;
let enabled = false;
let replenishing = false;

/**
 * Initialize the sidecar pool with pre-warmed containers.
 * Runs in background — if Docker is unavailable, pool is silently disabled.
 */
export async function initSidecarPool(): Promise<void> {
  try {
    standbyNetworkId = await createNetwork("appstrate-sidecar-pool");
    await replenish();
    enabled = true;
    logger.info("Sidecar pool initialized", { size: pool.length });
  } catch (err) {
    // Clean up the network if it was created before replenish() failed
    if (standbyNetworkId) {
      await removeNetwork(standbyNetworkId).catch(() => {});
      standbyNetworkId = undefined;
    }
    logger.warn("Sidecar pool disabled — falling back to on-demand creation", {
      error: err instanceof Error ? err.message : String(err),
    });
    enabled = false;
  }
}

/**
 * Acquire a pre-warmed sidecar from the pool.
 * Configures it with execution-specific credentials and connects to the execution network.
 * Returns the container ID, or null if pool is empty/disabled (caller falls back to fresh creation).
 */
export async function acquireSidecar(
  executionId: string,
  executionNetworkId: string,
  sidecarEnv: {
    executionToken: string;
    platformApiUrl: string;
    proxyUrl?: string;
    llm?: { baseUrl: string; apiKey: string; placeholder: string };
  },
  platformNetwork?: { networkId: string; hostname: string } | null,
): Promise<string | null> {
  if (!enabled || pool.length === 0) return null;

  const entry = pool.pop()!;

  try {
    // Configure sidecar via its host-mapped port (authenticated with one-time secret)
    const host = await getDockerHostAddress();
    const configRes = await fetch(`http://${host}:${entry.hostPort}/configure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.configSecret}`,
      },
      body: JSON.stringify({
        executionToken: sidecarEnv.executionToken,
        platformApiUrl: sidecarEnv.platformApiUrl,
        proxyUrl: sidecarEnv.proxyUrl || "",
        llm: sidecarEnv.llm,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!configRes.ok) {
      throw new Error(`Configure failed: ${configRes.status}`);
    }

    // Connect to execution network with "sidecar" alias for agent DNS resolution
    await connectContainerToNetwork(executionNetworkId, entry.containerId, ["sidecar"]);

    // Connect to platform network for host access (containerized deployments)
    if (platformNetwork) {
      await connectContainerToNetwork(platformNetwork.networkId, entry.containerId);
    }

    logger.debug("Acquired sidecar from pool", { executionId, containerId: entry.containerId });

    // Replenish pool in background (don't await)
    scheduleReplenish();

    return entry.containerId;
  } catch (err) {
    logger.warn("Failed to acquire sidecar from pool, will create fresh", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Clean up the failed container
    removeContainer(entry.containerId).catch(() => {});
    scheduleReplenish();
    return null;
  }
}

/** Shutdown the pool and clean up all containers. */
export async function shutdownSidecarPool(): Promise<void> {
  enabled = false;
  const entries = pool.splice(0);
  for (const entry of entries) {
    await removeContainer(entry.containerId).catch(() => {});
  }
  if (standbyNetworkId) {
    await removeNetwork(standbyNetworkId).catch(() => {});
    standbyNetworkId = undefined;
  }
  logger.info("Sidecar pool shut down");
}

/** Schedule background replenishment (debounced). */
function scheduleReplenish(): void {
  if (replenishing) return;
  replenishing = true;
  // Small delay to batch multiple acquisitions
  setTimeout(() => {
    replenish()
      .catch((err) => {
        logger.warn("Sidecar pool replenish failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        replenishing = false;
      });
  }, 100);
}

/** Create a single pooled sidecar container. */
async function createPooledSidecar(): Promise<PooledSidecar> {
  const configSecret = crypto.randomUUID();
  const containerId = await createContainer(
    crypto.randomUUID().slice(0, 8),
    { PORT: "8080", CONFIG_SECRET: configSecret },
    {
      image: SIDECAR_IMAGE,
      adapterName: "sidecar-pool",
      memory: SIDECAR_MEMORY_BYTES,
      nanoCpus: SIDECAR_NANO_CPUS,
      networkId: standbyNetworkId!,
      portBindings: { "8080/tcp": [{ HostPort: "0" }] },
      exposedPorts: SIDECAR_EXPOSED_PORTS,
      labels: { "appstrate.pool": "sidecar" },
    },
  );

  await startContainer(containerId);

  const hostPort = await getContainerHostPort(containerId, "8080/tcp");
  if (!hostPort) {
    await removeContainer(containerId).catch(() => {});
    throw new Error("No host port mapped for pooled sidecar");
  }

  await waitForSidecarHealth(hostPort);
  return { containerId, hostPort, configSecret };
}

/** Fill the pool to its target size (parallel creation). */
async function replenish(): Promise<void> {
  if (!standbyNetworkId) return;

  const needed = POOL_SIZE - pool.length;
  if (needed <= 0) return;

  const results = await Promise.allSettled(
    Array.from({ length: needed }, () => createPooledSidecar()),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      pool.push(result.value);
    } else {
      logger.warn("Failed to create pooled sidecar", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/** Wait for a sidecar to become healthy via its host-mapped port. */
export async function waitForSidecarHealth(hostPort: number): Promise<void> {
  const host = await getDockerHostAddress();
  for (let attempt = 0; attempt < HEALTH_CHECK_RETRIES; attempt++) {
    try {
      const res = await fetch(`http://${host}:${hostPort}/health`, {
        signal: AbortSignal.timeout(attempt < 3 ? 300 : 1000),
      });
      if (res.ok) return;
    } catch {
      // Retry
    }
    if (attempt < HEALTH_CHECK_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_DELAYS_MS[attempt]));
    }
  }
  throw new Error("Sidecar health check failed after retries");
}
