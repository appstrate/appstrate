// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, afterEach } from "bun:test";
import {
  pullImage,
  createContainer,
  startContainer,
  streamLogs,
  waitForExit,
  removeContainer,
  injectFiles,
  stopContainer,
  createNetwork,
  connectContainerToNetwork,
  removeNetwork,
  cleanupOrphanedContainers,
  cleanupOrphanedNetworks,
  getContainerHostPort,
} from "../../../src/services/docker.ts";

// ─── Constants ──────────────────────────────────────────────

const DOCKER_URL = "http://localhost:2375";
const IMAGE = "alpine:3.20";
const TIMEOUT = 15_000;

// ─── Cleanup tracking ───────────────────────────────────────

const containersToCleanup: string[] = [];
const networksToCleanup: string[] = [];

function trackContainer(id: string): string {
  containersToCleanup.push(id);
  return id;
}

function trackNetwork(id: string): string {
  networksToCleanup.push(id);
  return id;
}

function untrackContainer(id: string): void {
  const idx = containersToCleanup.indexOf(id);
  if (idx >= 0) containersToCleanup.splice(idx, 1);
}

/** Force-remove a container via raw fetch (bypass the module under test for cleanup). */
async function rawRemoveContainer(id: string): Promise<void> {
  try {
    await fetch(`${DOCKER_URL}/containers/${id}?force=true&v=true`, { method: "DELETE" });
  } catch {
    // ignore
  }
}

/** Remove a network via raw fetch. */
async function rawRemoveNetwork(id: string): Promise<void> {
  try {
    await fetch(`${DOCKER_URL}/networks/${id}`, { method: "DELETE" });
  } catch {
    // ignore
  }
}

afterEach(async () => {
  // Clean up containers first (they may be connected to networks)
  await Promise.allSettled(containersToCleanup.map(rawRemoveContainer));
  containersToCleanup.length = 0;

  // Then clean up networks
  await Promise.allSettled(networksToCleanup.map(rawRemoveNetwork));
  networksToCleanup.length = 0;
});

// ─── Helpers ────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Create a container via raw Docker API with a custom Cmd.
 * createContainer() in docker.ts does not accept Cmd — it relies on the image default.
 * For tests that need a specific command, we create via raw API and track for cleanup.
 */
async function createRawContainer(
  cmd: string[],
  opts: {
    env?: string[];
    labels?: Record<string, string>;
    exposedPorts?: Record<string, object>;
    portBindings?: Record<string, Array<{ HostPort: string }>>;
  } = {},
): Promise<string> {
  const name = `appstrate-test-raw-${uid()}`;
  const res = await fetch(`${DOCKER_URL}/containers/create?name=${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Image: IMAGE,
      Cmd: cmd,
      Tty: false,
      Env: opts.env,
      ExposedPorts: opts.exposedPorts,
      HostConfig: {
        PortBindings: opts.portBindings,
      },
      Labels: {
        "appstrate.managed": "true",
        "appstrate.run": `test-${uid()}`,
        "appstrate.adapter": "test",
        ...opts.labels,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create raw container: ${res.status} ${err}`);
  }
  const data = (await res.json()) as { Id: string };
  return trackContainer(data.Id);
}

// ─── pullImage ──────────────────────────────────────────────

describe("pullImage", () => {
  it(
    "pulls alpine:3.20 (cached, fast)",
    async () => {
      await pullImage(IMAGE);
    },
    TIMEOUT,
  );

  it(
    "throws on non-existent image",
    async () => {
      await expect(pullImage("nonexistent-image-xxx:99.99.99")).rejects.toThrow(/pull image/);
    },
    TIMEOUT,
  );
});

// ─── createContainer ────────────────────────────────────────

describe("createContainer", () => {
  it(
    "creates a container and returns its ID",
    async () => {
      const runId = `test-${uid()}`;
      const id = await createContainer(
        runId,
        {},
        {
          image: IMAGE,
          adapterName: "test",
        },
      );
      trackContainer(id);

      expect(id).toBeString();
      expect(id.length).toBeGreaterThan(10);
    },
    TIMEOUT,
  );

  it(
    "sets custom labels on the container",
    async () => {
      const runId = `test-${uid()}`;
      const id = await createContainer(
        runId,
        {},
        {
          image: IMAGE,
          adapterName: "test",
          labels: { "test.custom": "myvalue" },
        },
      );
      trackContainer(id);

      const res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      const data = (await res.json()) as any;
      expect(data.Config.Labels["test.custom"]).toBe("myvalue");
      expect(data.Config.Labels["appstrate.managed"]).toBe("true");
      expect(data.Config.Labels["appstrate.run"]).toBe(runId);
      expect(data.Config.Labels["appstrate.adapter"]).toBe("test");
    },
    TIMEOUT,
  );

  it(
    "passes environment variables to the container",
    async () => {
      const runId = `test-${uid()}`;
      const id = await createContainer(
        runId,
        { MY_VAR: "hello", OTHER: "world" },
        { image: IMAGE, adapterName: "test" },
      );
      trackContainer(id);

      const res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      const data = (await res.json()) as any;
      const envArr = data.Config.Env as string[];
      expect(envArr).toContain("MY_VAR=hello");
      expect(envArr).toContain("OTHER=world");
    },
    TIMEOUT,
  );

  it(
    "throws on invalid image",
    async () => {
      const runId = `test-${uid()}`;
      await expect(createContainer(runId, {}, { image: "", adapterName: "test" })).rejects.toThrow(
        "Docker create test container failed",
      );
    },
    TIMEOUT,
  );
});

// ─── startContainer ─────────────────────────────────────────

describe("startContainer", () => {
  it(
    "starts a container successfully",
    async () => {
      const id = await createRawContainer(["sleep", "10"]);
      await startContainer(id);

      const res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      const data = (await res.json()) as any;
      expect(data.State.Running).toBe(true);
    },
    TIMEOUT,
  );
});

// ─── streamLogs ─────────────────────────────────────────────

describe("streamLogs", () => {
  it(
    "captures stdout output",
    async () => {
      const id = await createRawContainer(["sh", "-c", "echo hello && echo world"]);
      await startContainer(id);

      const lines: string[] = [];
      for await (const line of streamLogs(id)) {
        lines.push(line);
      }

      expect(lines).toContain("hello");
      expect(lines).toContain("world");
    },
    TIMEOUT,
  );

  it(
    "captures stderr output",
    async () => {
      const id = await createRawContainer(["sh", "-c", "echo err >&2"]);
      await startContainer(id);

      const lines: string[] = [];
      for await (const line of streamLogs(id)) {
        lines.push(line);
      }

      expect(lines).toContain("err");
    },
    TIMEOUT,
  );

  it(
    "stops iteration on abort signal",
    async () => {
      const id = await createRawContainer([
        "sh",
        "-c",
        "while true; do echo tick; sleep 0.1; done",
      ]);
      await startContainer(id);

      const controller = new AbortController();
      const lines: string[] = [];

      setTimeout(() => controller.abort(), 500);

      for await (const line of streamLogs(id, controller.signal)) {
        lines.push(line);
      }

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toBe("tick");
    },
    TIMEOUT,
  );
});

// ─── waitForExit ────────────────────────────────────────────

describe("waitForExit", () => {
  it(
    "returns exit code 0 for successful command",
    async () => {
      const id = await createRawContainer(["true"]);
      await startContainer(id);

      const code = await waitForExit(id);
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "returns non-zero exit code for failing command",
    async () => {
      const id = await createRawContainer(["false"]);
      await startContainer(id);

      const code = await waitForExit(id);
      expect(code).toBe(1);
    },
    TIMEOUT,
  );
});

// ─── stopContainer ──────────────────────────────────────────

describe("stopContainer", () => {
  it(
    "stops a running container",
    async () => {
      const id = await createRawContainer(["sleep", "60"]);
      await startContainer(id);

      let res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      let data = (await res.json()) as any;
      expect(data.State.Running).toBe(true);

      await stopContainer(id, 1);

      res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      data = (await res.json()) as any;
      expect(data.State.Running).toBe(false);
    },
    TIMEOUT,
  );
});

// ─── removeContainer ────────────────────────────────────────

describe("removeContainer", () => {
  it(
    "removes a container",
    async () => {
      const id = await createRawContainer(["true"]);

      await removeContainer(id);

      const res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      expect(res.status).toBe(404);

      untrackContainer(id);
    },
    TIMEOUT,
  );

  it(
    "does not throw for non-existent container (404 tolerance)",
    async () => {
      await expect(removeContainer("nonexistent-container-id-12345")).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

// ─── injectFiles ────────────────────────────────────────────

describe("injectFiles", () => {
  it(
    "injects a file into a container and verifies content via cat",
    async () => {
      const fileContent = "hello from injected file";
      const id = await createRawContainer(["cat", "/tmp/test.txt"]);

      await injectFiles(id, [{ name: "test.txt", content: Buffer.from(fileContent) }], "/tmp");

      await startContainer(id);

      const lines: string[] = [];
      for await (const line of streamLogs(id)) {
        lines.push(line);
      }

      expect(lines).toContain(fileContent);
    },
    TIMEOUT,
  );

  it(
    "injects multiple files in a single tar archive",
    async () => {
      const id = await createRawContainer(["sh", "-c", "cat /tmp/a.txt && cat /tmp/b.txt"]);

      await injectFiles(
        id,
        [
          { name: "a.txt", content: Buffer.from("content-a") },
          { name: "b.txt", content: Buffer.from("content-b") },
        ],
        "/tmp",
      );

      await startContainer(id);

      const lines: string[] = [];
      for await (const line of streamLogs(id)) {
        lines.push(line);
      }

      const output = lines.join("\n");
      expect(output).toContain("content-a");
      expect(output).toContain("content-b");
    },
    TIMEOUT,
  );

  it(
    "does nothing when files array is empty",
    async () => {
      const id = await createRawContainer(["true"]);
      await injectFiles(id, [], "/tmp");
      // No error thrown
    },
    TIMEOUT,
  );
});

// ─── createNetwork ──────────────────────────────────────────

describe("createNetwork", () => {
  it(
    "creates a bridge network and returns its ID",
    async () => {
      const name = `appstrate-test-net-${uid()}`;
      const networkId = await createNetwork(name);
      trackNetwork(networkId);

      expect(networkId).toBeString();
      expect(networkId.length).toBeGreaterThan(10);

      const res = await fetch(`${DOCKER_URL}/networks/${networkId}`);
      expect(res.status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    "creates an internal network when requested",
    async () => {
      const name = `appstrate-test-internal-${uid()}`;
      const networkId = await createNetwork(name, { internal: true });
      trackNetwork(networkId);

      const res = await fetch(`${DOCKER_URL}/networks/${networkId}`);
      const data = (await res.json()) as any;
      expect(data.Internal).toBe(true);
    },
    TIMEOUT,
  );
});

// ─── connectContainerToNetwork ──────────────────────────────

describe("connectContainerToNetwork", () => {
  it(
    "connects a container to a network with aliases",
    async () => {
      const networkName = `appstrate-test-conn-${uid()}`;
      const networkId = await createNetwork(networkName);
      trackNetwork(networkId);

      const containerId = await createRawContainer(["sleep", "10"]);
      await startContainer(containerId);

      await connectContainerToNetwork(networkId, containerId, ["my-alias"]);

      const res = await fetch(`${DOCKER_URL}/containers/${containerId}/json`);
      const data = (await res.json()) as any;
      const networks = data.NetworkSettings.Networks;
      const networkEntry = Object.values(networks).find(
        (n: any) => n.NetworkID === networkId,
      ) as any;
      expect(networkEntry).toBeDefined();
      expect(networkEntry.Aliases).toContain("my-alias");
    },
    TIMEOUT,
  );
});

// ─── removeNetwork ──────────────────────────────────────────

describe("removeNetwork", () => {
  it(
    "creates and removes a network",
    async () => {
      const name = `appstrate-test-rm-${uid()}`;
      const networkId = await createNetwork(name);

      await removeNetwork(networkId);

      const res = await fetch(`${DOCKER_URL}/networks/${networkId}`);
      expect(res.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "does not throw for non-existent network (404 tolerance)",
    async () => {
      await expect(removeNetwork("nonexistent-network-id-12345")).resolves.toBeUndefined();
    },
    TIMEOUT,
  );
});

// ─── getContainerHostPort ───────────────────────────────────

describe("getContainerHostPort", () => {
  it(
    "returns the mapped host port for a container with port binding",
    async () => {
      // Create container with port binding via raw API
      const id = await createRawContainer(["sh", "-c", "nc -l -p 8080 || sleep 10"], {
        exposedPorts: { "8080/tcp": {} },
        portBindings: { "8080/tcp": [{ HostPort: "0" }] },
      });
      await startContainer(id);

      const port = await getContainerHostPort(id, "8080/tcp");
      expect(port).toBeNumber();
      expect(port!).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "returns null for non-existent container",
    async () => {
      const port = await getContainerHostPort("nonexistent-container-12345", "8080/tcp");
      expect(port).toBeNull();
    },
    TIMEOUT,
  );
});

// ─── cleanupOrphanedContainers ──────────────────────────────

describe("cleanupOrphanedContainers", () => {
  it(
    "cleans up labeled containers and networks",
    async () => {
      // Create containers with the managed label
      const id1 = await createRawContainer(["sleep", "60"]);
      const id2 = await createRawContainer(["sleep", "60"]);
      await startContainer(id1);
      await startContainer(id2);

      // Create a network with matching name pattern
      const netName = `appstrate-exec-test-${uid()}`;
      const netId = await createNetwork(netName);
      // Do not track — cleanupOrphanedContainers should remove it

      const result = await cleanupOrphanedContainers();

      // Should have removed at least our 2 containers
      expect(result.containers).toBeGreaterThanOrEqual(2);

      // Verify containers are gone
      const res1 = await fetch(`${DOCKER_URL}/containers/${id1}/json`);
      expect(res1.status).toBe(404);
      const res2 = await fetch(`${DOCKER_URL}/containers/${id2}/json`);
      expect(res2.status).toBe(404);

      // Verify network was cleaned up (name starts with appstrate-exec-)
      const netRes = await fetch(`${DOCKER_URL}/networks/${netId}`);
      expect(netRes.status).toBe(404);

      // Clear cleanup tracking since cleanupOrphanedContainers handled removal
      containersToCleanup.length = 0;
    },
    TIMEOUT,
  );

  it(
    "returns zero when no orphans exist",
    async () => {
      // Ensure clean state
      await cleanupOrphanedContainers();

      const result = await cleanupOrphanedContainers();
      expect(result.containers).toBe(0);
    },
    TIMEOUT,
  );
});

// ─── cleanupOrphanedNetworks ─────────────────────────────────

describe("cleanupOrphanedNetworks", () => {
  it(
    "reclaims appstrate-exec-* networks without touching unrelated networks",
    async () => {
      // Pre-condition: clear any leftovers from earlier tests.
      await cleanupOrphanedNetworks();

      // Three orphan run networks + one unrelated bystander that must survive.
      const orphan1 = await createNetwork(`appstrate-exec-orphan-${uid()}`);
      const orphan2 = await createNetwork(`appstrate-exec-orphan-${uid()}`);
      const orphan3 = await createNetwork(`appstrate-exec-orphan-${uid()}`);
      const bystander = await createNetwork(`appstrate-test-keepme-${uid()}`);
      trackNetwork(bystander);

      const reclaimed = await cleanupOrphanedNetworks();
      expect(reclaimed).toBeGreaterThanOrEqual(3);

      for (const id of [orphan1, orphan2, orphan3]) {
        const res = await fetch(`${DOCKER_URL}/networks/${id}`);
        expect(res.status).toBe(404);
      }
      const stillThere = await fetch(`${DOCKER_URL}/networks/${bystander}`);
      expect(stillThere.status).toBe(200);
    },
    TIMEOUT,
  );
});

// ─── Full lifecycle ─────────────────────────────────────────

describe("Full lifecycle", () => {
  it("create -> inject -> start -> streamLogs -> waitForExit -> remove", async () => {
    // Create container with a command that cats an injected file
    const id = await createRawContainer(["sh", "/tmp/run.sh"], { env: ["GREETING=world"] });

    // Inject a script before starting
    await injectFiles(
      id,
      [{ name: "run.sh", content: Buffer.from('#!/bin/sh\necho "hello $GREETING"') }],
      "/tmp",
    );

    await startContainer(id);

    // Stream logs
    const lines: string[] = [];
    for await (const line of streamLogs(id)) {
      lines.push(line);
    }

    // Wait for exit
    const exitCode = await waitForExit(id);
    expect(exitCode).toBe(0);
    expect(lines.join(" ")).toContain("hello world");

    // Remove
    await removeContainer(id);
    untrackContainer(id);

    // Verify gone
    const res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
    expect(res.status).toBe(404);
  }, 30_000);
});
