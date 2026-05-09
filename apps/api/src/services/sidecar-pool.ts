// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
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
import { getErrorMessage } from "@appstrate/core/errors";
import {
  SIDECAR_MEMORY_BYTES,
  SIDECAR_NANO_CPUS,
  SIDECAR_EXPOSED_PORTS,
  SIDECAR_PORT_BINDINGS,
  SIDECAR_INTERNAL_PORT,
} from "./orchestrator/constants.ts";
export const getSidecarImage = () => getEnv().SIDECAR_IMAGE;
// Sidecar cold-start can legitimately take 20–45 seconds in Tier 3 self-hosted
// installs (image pull + container start + Bun runtime warmup + first /health).
// The original 15 retries × short delays gave a total budget of ~4 seconds —
// systematically too short, causing every fresh sidecar to be marked failed
// before it had a chance to listen, and silently breaking the pool replenisher
// (initSidecarPool() returns size:0 with two "Failed to create pooled sidecar"
// logs on every API boot).
//
// The shape preserves the original fine-grained head (catches warm starts in
// <500 ms — pool replenish, hot Docker daemon, cached image) and only adds a
// coarse tail for the cold-start case. Total budget ~75 s, dominated by the
// tail; the warm path is unchanged.
const HEALTH_CHECK_RETRIES = 35;
const HEALTH_CHECK_DELAYS_MS = [
  // Original fast-path (sum ~4 s) — catches warm starts quickly.
  25, 50, 50, 100, 100, 200, 200, 400, 400, 400, 400, 400, 400, 400, 400,
  // Cold-start tail (sum ~71 s) — covers 24–45 s container boot.
  1000, 1000, 1000, 2000, 2000, 2000, 3000, 3000, 3000, 3000, 5000, 5000, 5000, 5000, 5000, 5000,
  5000, 5000, 5000, 5000,
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
      await removeNetwork(standbyNetworkId).catch((err) =>
        logger.warn("Failed to remove network", {
          networkId: standbyNetworkId,
          error: getErrorMessage(err),
        }),
      );
      standbyNetworkId = undefined;
    }
    logger.warn("Sidecar pool disabled — falling back to on-demand creation", {
      error: getErrorMessage(err),
    });
    enabled = false;
  }
}

/**
 * Acquire a pre-warmed sidecar from the pool.
 * Configures it with run-specific credentials and connects to the run network.
 * Returns the container ID, or null if pool is empty/disabled (caller falls back to fresh creation).
 */
export async function acquireSidecar(
  runId: string,
  runNetworkId: string,
  sidecarEnv: {
    runToken: string;
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
        runToken: sidecarEnv.runToken,
        platformApiUrl: sidecarEnv.platformApiUrl,
        proxyUrl: sidecarEnv.proxyUrl || "",
        llm: sidecarEnv.llm,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!configRes.ok) {
      throw new Error(`Configure failed: ${configRes.status}`);
    }

    // Connect to run network with "sidecar" alias for agent DNS resolution
    await connectContainerToNetwork(runNetworkId, entry.containerId, ["sidecar"]);

    // Connect to platform network for host access (containerized deployments)
    if (platformNetwork) {
      await connectContainerToNetwork(platformNetwork.networkId, entry.containerId);
    }

    logger.debug("Acquired sidecar from pool", { runId, containerId: entry.containerId });

    // Replenish pool in background (don't await)
    scheduleReplenish();

    return entry.containerId;
  } catch (err) {
    logger.warn("Failed to acquire sidecar from pool, will create fresh", {
      error: getErrorMessage(err),
    });
    // Clean up the failed container
    removeContainer(entry.containerId).catch((err) =>
      logger.warn("Failed to remove container", {
        containerId: entry.containerId,
        error: getErrorMessage(err),
      }),
    );
    scheduleReplenish();
    return null;
  }
}

/** Shutdown the pool and clean up all containers. */
export async function shutdownSidecarPool(): Promise<void> {
  enabled = false;
  const entries = pool.splice(0);
  for (const entry of entries) {
    await removeContainer(entry.containerId).catch((err) =>
      logger.warn("Failed to remove container", {
        containerId: entry.containerId,
        error: getErrorMessage(err),
      }),
    );
  }
  if (standbyNetworkId) {
    await removeNetwork(standbyNetworkId).catch((err) =>
      logger.warn("Failed to remove network", {
        networkId: standbyNetworkId,
        error: getErrorMessage(err),
      }),
    );
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
          error: getErrorMessage(err),
        });
      })
      .finally(() => {
        replenishing = false;
      });
  }, 100);
}

/** Start a sidecar container and wait for health check. Returns the host port. */
export async function startSidecarAndHealthCheck(containerId: string): Promise<number> {
  await startContainer(containerId);
  const hostPort = await getContainerHostPort(containerId, SIDECAR_INTERNAL_PORT);
  if (!hostPort) {
    await removeContainer(containerId).catch((err) =>
      logger.warn("Failed to remove container", {
        containerId,
        error: getErrorMessage(err),
      }),
    );
    throw new Error("No host port mapped for sidecar");
  }
  await waitForSidecarHealth(hostPort);
  return hostPort;
}

/** Create a single pooled sidecar container. */
async function createPooledSidecar(): Promise<PooledSidecar> {
  const configSecret = crypto.randomUUID();
  // Operator-tunable sidecar caps are forwarded from the API host so
  // pooled sidecars enforce the same limits as freshly-spawned ones.
  // The values are frozen at module load inside the sidecar, so an env
  // change on the API host requires recycling the pool to take effect.
  const containerId = await createContainer(
    crypto.randomUUID().slice(0, 8),
    { PORT: "8080", CONFIG_SECRET: configSecret, ...pickOperatorSidecarEnv() },
    {
      image: getSidecarImage(),
      adapterName: "sidecar-pool",
      memory: SIDECAR_MEMORY_BYTES,
      nanoCpus: SIDECAR_NANO_CPUS,
      networkId: standbyNetworkId!,
      extraHosts: ["host.docker.internal:host-gateway"],
      portBindings: SIDECAR_PORT_BINDINGS,
      exposedPorts: SIDECAR_EXPOSED_PORTS,
      labels: {
        "appstrate.pool": "sidecar",
        "com.docker.compose.project": "appstrate-sidecar-pool",
      },
    },
  );

  const hostPort = await startSidecarAndHealthCheck(containerId);
  return { containerId, hostPort, configSecret };
}

/** Fill the pool to its target size (parallel creation). */
async function replenish(): Promise<void> {
  if (!standbyNetworkId) return;

  const needed = getEnv().SIDECAR_POOL_SIZE - pool.length;
  if (needed <= 0) return;

  const results = await Promise.allSettled(
    Array.from({ length: needed }, () => createPooledSidecar()),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      pool.push(result.value);
    } else {
      logger.warn("Failed to create pooled sidecar", {
        error: getErrorMessage(result.reason),
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
