// SPDX-License-Identifier: Apache-2.0

/**
 * Sidecar pool integration tests.
 *
 * Uses Docker-in-Docker (via test Docker Compose) with alpine:3.20 to test
 * the pool infrastructure: network creation, container lifecycle, port mapping,
 * and cleanup. Does NOT test the actual sidecar image behavior (health check,
 * /configure endpoint) — that requires the real sidecar image to be built.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  createContainer,
  startContainer,
  removeContainer,
  createNetwork,
  removeNetwork,
  getContainerHostPort,
  connectContainerToNetwork,
} from "../../../src/services/docker.ts";

const DOCKER_URL = "http://localhost:2375";
const IMAGE = "alpine:3.20";

const containersToCleanup: string[] = [];
const networksToCleanup: string[] = [];

/** Create a container with a custom Cmd via raw Docker API (createContainer doesn't support Cmd). */
async function createRawContainer(
  cmd: string[],
  opts: {
    networkId?: string;
    portBindings?: Record<string, Array<{ HostPort: string }>>;
    exposedPorts?: Record<string, object>;
    labels?: Record<string, string>;
  } = {},
): Promise<string> {
  const res = await fetch(`${DOCKER_URL}/containers/create?name=test-pool-${uid()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Image: IMAGE,
      Cmd: cmd,
      ExposedPorts: opts.exposedPorts,
      HostConfig: {
        NetworkMode: opts.networkId ?? "bridge",
        PortBindings: opts.portBindings,
      },
      Labels: { "appstrate.managed": "true", ...opts.labels },
    }),
  });
  const data = (await res.json()) as { Id: string };
  containersToCleanup.push(data.Id);
  return data.Id;
}

afterEach(async () => {
  await Promise.allSettled(
    containersToCleanup.map((id) =>
      fetch(`${DOCKER_URL}/containers/${id}?force=true&v=true`, { method: "DELETE" }).catch(
        () => {},
      ),
    ),
  );
  containersToCleanup.length = 0;

  await Promise.allSettled(
    networksToCleanup.map((id) =>
      fetch(`${DOCKER_URL}/networks/${id}`, { method: "DELETE" }).catch(() => {}),
    ),
  );
  networksToCleanup.length = 0;
});

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

describe("sidecar pool infrastructure", () => {
  it("creates a standby network for pooled containers", async () => {
    const netId = await createNetwork(`test-pool-${uid()}`);
    networksToCleanup.push(netId);

    expect(typeof netId).toBe("string");
    expect(netId.length).toBeGreaterThan(0);
  });

  it("creates a container with port mapping and retrieves host port", async () => {
    const netId = await createNetwork(`test-pool-${uid()}`);
    networksToCleanup.push(netId);

    // Use raw API with "sleep 30" to keep the container alive (alpine exits immediately otherwise)
    const containerId = await createRawContainer(["sleep", "30"], {
      networkId: netId,
      portBindings: { "8080/tcp": [{ HostPort: "0" }] },
      exposedPorts: { "8080/tcp": {} },
      labels: { "appstrate.pool": "sidecar" },
    });

    await startContainer(containerId);

    const hostPort = await getContainerHostPort(containerId, "8080/tcp");
    expect(hostPort).not.toBeNull();
    expect(typeof hostPort).toBe("number");
    expect(hostPort!).toBeGreaterThan(0);
  });

  it("connects a pooled container to an execution network with alias", async () => {
    const poolNet = await createNetwork(`test-pool-${uid()}`);
    networksToCleanup.push(poolNet);

    const execNet = await createNetwork(`test-exec-${uid()}`);
    networksToCleanup.push(execNet);

    // Use sleep to keep the container alive for network inspection
    const containerId = await createRawContainer(["sleep", "30"], { networkId: poolNet });

    await startContainer(containerId);

    // Connect to execution network with "sidecar" alias (simulates acquireSidecar)
    await connectContainerToNetwork(execNet, containerId, ["sidecar"]);

    // Verify via Docker inspect
    const res = await fetch(`${DOCKER_URL}/containers/${containerId}/json`);
    const data = (await res.json()) as any;
    const networks = data.NetworkSettings?.Networks ?? {};

    // Should be on both networks
    const networkNames = Object.keys(networks);
    expect(networkNames.length).toBeGreaterThanOrEqual(2);
  });

  it("parallel container creation (simulates replenish)", async () => {
    const netId = await createNetwork(`test-pool-${uid()}`);
    networksToCleanup.push(netId);

    // Create 3 containers in parallel (simulating pool replenish)
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        createContainer(
          uid(),
          {},
          {
            image: IMAGE,
            adapterName: "sidecar-pool-test",
            networkId: netId,
            labels: { "appstrate.pool": "sidecar", "appstrate.managed": "true" },
          },
        ),
      ),
    );

    const created = results.filter((r) => r.status === "fulfilled");
    for (const r of created) {
      containersToCleanup.push((r as PromiseFulfilledResult<string>).value);
    }

    expect(created.length).toBe(3);
  });

  it("shutdown cleans up all pooled containers and network", async () => {
    const netId = await createNetwork(`test-pool-${uid()}`);

    // Create 2 containers
    const c1 = await createContainer(
      uid(),
      {},
      {
        image: IMAGE,
        adapterName: "sidecar-pool-test",
        networkId: netId,
        labels: { "appstrate.pool": "sidecar", "appstrate.managed": "true" },
      },
    );
    const c2 = await createContainer(
      uid(),
      {},
      {
        image: IMAGE,
        adapterName: "sidecar-pool-test",
        networkId: netId,
        labels: { "appstrate.pool": "sidecar", "appstrate.managed": "true" },
      },
    );

    await startContainer(c1);
    await startContainer(c2);

    // Simulate shutdown: remove containers then network
    await removeContainer(c1);
    await removeContainer(c2);
    await removeNetwork(netId);

    // Verify containers are gone
    const r1 = await fetch(`${DOCKER_URL}/containers/${c1}/json`);
    expect(r1.status).toBe(404);

    const r2 = await fetch(`${DOCKER_URL}/containers/${c2}/json`);
    expect(r2.status).toBe(404);

    // Verify network is gone
    const rn = await fetch(`${DOCKER_URL}/networks/${netId}`);
    expect(rn.status).toBe(404);
  });

  it("container with labels can be found via filters", async () => {
    const netId = await createNetwork(`test-pool-${uid()}`);
    networksToCleanup.push(netId);

    const containerId = await createContainer(
      uid(),
      {},
      {
        image: IMAGE,
        adapterName: "sidecar-pool-test",
        networkId: netId,
        labels: { "appstrate.pool": "sidecar", "appstrate.managed": "true" },
      },
    );
    containersToCleanup.push(containerId);

    // List containers by label (same filter used by cleanupOrphanedContainers)
    const filters = JSON.stringify({ label: ["appstrate.pool=sidecar"] });
    const res = await fetch(
      `${DOCKER_URL}/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
    );
    const containers = (await res.json()) as Array<{ Id: string }>;

    expect(containers.some((c) => c.Id === containerId)).toBe(true);
  });
});
