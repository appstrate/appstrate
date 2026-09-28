// SPDX-License-Identifier: Apache-2.0

/**
 * DockerOrchestrator network placement, against the real Docker daemon (DinD).
 *
 * - An agent workload sits on its run's isolation boundary only — never on the
 *   shared egress network, which is the sidecar's.
 * - Regression #834: the shared egress network is durable infrastructure that
 *   `shutdown()` leaves in place for other instances. Its by-name self-heal
 *   is covered in `docker-api.test.ts`.
 */

import { expect, it, afterEach } from "bun:test";
import { describeRequiresDocker } from "../../helpers/tier.ts";
import { DockerOrchestrator } from "../../../src/services/orchestrator/docker-orchestrator.ts";
import {
  ensureNetwork,
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

describeRequiresDocker("DockerOrchestrator network placement", () => {
  it(
    "attaches an agent workload to its isolation boundary only",
    async () => {
      const runId = `agent-net-${uid()}`;
      runsToCleanup.push(runId);
      await ensureNetwork(EGRESS_NETWORK_NAME);

      const boundary = await orchestrator.createIsolationBoundary(runId);
      boundariesToCleanup.push(boundary);

      const handle: WorkloadHandle = await orchestrator.createWorkload(
        {
          runId,
          role: "agent",
          image: IMAGE,
          env: {},
          resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 500_000_000 },
        },
        boundary,
      );

      const networks = await inspectContainerNetworks(handle.id);
      expect(Object.keys(networks)).toEqual([boundary.name]);
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
