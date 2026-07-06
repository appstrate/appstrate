// SPDX-License-Identifier: Apache-2.0

/**
 * Regression #834 — orchestrator-level: the DockerOrchestrator used to cache
 * the egress network's ID at boot and reuse it for every run. When the
 * network disappeared mid-lifetime (concurrent Appstrate instance shutting
 * down, `docker network prune`, daemon restart) every subsequent run failed
 * with `network <staleId> not found` until the API was restarted.
 *
 * The fix resolves the egress network **by name at use time** (create-or-get
 * via `ensureNetwork`), so a run launched after the network vanished simply
 * recreates it. These tests exercise the exact repro from the issue against
 * the real Docker daemon (DinD).
 */

import { expect, it, afterEach } from "bun:test";
import { describeRequiresDocker } from "../../helpers/tier.ts";
import { DockerOrchestrator } from "../../../src/services/orchestrator/docker-orchestrator.ts";
import {
  ensureNetwork,
  removeNetwork,
  removeContainersByRun,
  EGRESS_NETWORK_NAME,
} from "../../../src/services/docker.ts";
import type { IsolationBoundary, WorkloadHandle } from "@appstrate/core/platform-types";

const DOCKER_URL = "http://localhost:2375";
const IMAGE = "alpine:3.20";
const TIMEOUT = 30_000;

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const orchestrator = new DockerOrchestrator();

// Per-test resources reclaimed even on assertion failure.
const runsToCleanup: string[] = [];
const boundariesToCleanup: IsolationBoundary[] = [];

afterEach(async () => {
  await Promise.allSettled(runsToCleanup.map((runId) => removeContainersByRun(runId)));
  runsToCleanup.length = 0;
  await Promise.allSettled(boundariesToCleanup.map((b) => orchestrator.removeIsolationBoundary(b)));
  boundariesToCleanup.length = 0;
});

async function inspectContainerNetworks(containerId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${DOCKER_URL}/containers/${containerId}/json`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    NetworkSettings: { Networks: Record<string, unknown> };
  };
  return data.NetworkSettings.Networks;
}

describeRequiresDocker("DockerOrchestrator egress network resilience (#834)", () => {
  it(
    "launches an egress workload after the egress network was deleted out of band",
    async () => {
      const runId = `egress-heal-${uid()}`;
      runsToCleanup.push(runId);

      // Boot-equivalent: the network exists (a previous run / initialize
      // created it)...
      const staleId = await ensureNetwork(EGRESS_NETWORK_NAME);

      const boundary = await orchestrator.createIsolationBoundary(runId);
      boundariesToCleanup.push(boundary);

      // ...then a concurrent instance's shutdown (or `docker network rm
      // appstrate-egress`) deletes it while this process is still alive.
      await removeNetwork(staleId);

      // Next run must self-heal: create + START must succeed (the issue's
      // failure mode was `Docker start container failed: 404 network not
      // found` — create alone doesn't prove the wiring works).
      const handle: WorkloadHandle = await orchestrator.createWorkload(
        {
          runId,
          role: "agent",
          image: IMAGE,
          env: {},
          resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 500_000_000 },
          egress: true,
        },
        boundary,
      );
      await orchestrator.startWorkload(handle);
      const exitCode = await orchestrator.waitForExit(handle);
      expect(exitCode).toBe(0);

      // The workload landed on a *fresh* egress network, not the stale ID.
      const networks = await inspectContainerNetworks(handle.id);
      const egressEndpoint = networks[EGRESS_NETWORK_NAME] as { NetworkID: string } | undefined;
      expect(egressEndpoint).toBeDefined();
      expect(egressEndpoint!.NetworkID).not.toBe(staleId);
    },
    TIMEOUT,
  );

  it(
    "shutdown() leaves the shared egress network in place for other instances",
    async () => {
      const egressId = await ensureNetwork(EGRESS_NETWORK_NAME);

      await orchestrator.shutdown();

      const res = await fetch(`${DOCKER_URL}/networks/${egressId}`);
      expect(res.status).toBe(200);
    },
    TIMEOUT,
  );
});
