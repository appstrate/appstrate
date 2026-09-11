// SPDX-License-Identifier: Apache-2.0

import { expect, it, afterEach } from "bun:test";
import { describeRequiresDocker } from "../../helpers/tier.ts";
import {
  pullImage,
  createContainer,
  startContainer,
  streamLogs,
  waitForExit,
  removeContainer,
  stopContainer,
  createNetwork,
  ensureNetwork,
  connectContainerToNetwork,
  removeNetwork,
  cleanupOrphanedContainers,
  cleanupOrphanedNetworks,
  cleanupOrphanedVolumes,
  EGRESS_NETWORK_NAME,
  createVolume,
  removeVolume,
  runEphemeralCommand,
  WORKSPACE_VOLUME_PREFIX,
  ensureImagePin,
  IMAGE_PIN_PREFIX,
} from "../../../src/services/docker.ts";
import { DockerContainerDisappearedError } from "../../../src/services/docker-errors.ts";

// ─── Constants ──────────────────────────────────────────────

const DOCKER_URL = "http://localhost:2375";
const IMAGE = "alpine:3.20";
const TIMEOUT = 15_000;

// ─── Cleanup tracking ───────────────────────────────────────

const containersToCleanup: string[] = [];
const networksToCleanup: string[] = [];
const volumesToCleanup: string[] = [];

function trackContainer(id: string): string {
  containersToCleanup.push(id);
  return id;
}

function trackNetwork(id: string): string {
  networksToCleanup.push(id);
  return id;
}

function trackVolume(name: string): string {
  volumesToCleanup.push(name);
  return name;
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

async function rawRemoveVolume(name: string): Promise<void> {
  try {
    await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(name)}?force=true`, {
      method: "DELETE",
    });
  } catch {
    // ignore
  }
}

afterEach(async () => {
  // Clean up containers first (they may be connected to networks / volumes)
  await Promise.allSettled(containersToCleanup.map(rawRemoveContainer));
  containersToCleanup.length = 0;

  // Then clean up networks and volumes (independent — race them).
  await Promise.allSettled([
    ...networksToCleanup.map(rawRemoveNetwork),
    ...volumesToCleanup.map(rawRemoveVolume),
  ]);
  networksToCleanup.length = 0;
  volumesToCleanup.length = 0;
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

describeRequiresDocker("pullImage", () => {
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

describeRequiresDocker("createContainer", () => {
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

describeRequiresDocker("startContainer", () => {
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

describeRequiresDocker("streamLogs", () => {
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

describeRequiresDocker("waitForExit", () => {
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

  it(
    "rejects instead of reporting SIGKILL when the container disappears mid-poll (#1130)",
    async () => {
      // Returning 137 here asserted an OOM kill that never happened and sent
      // the investigation after a memory ceiling. The exit status of a
      // container that is gone is unknowable — say so.
      const id = await createRawContainer(["sleep", "60"]);
      await startContainer(id);

      const exit = waitForExit(id);
      await removeContainer(id);
      untrackContainer(id);

      await expect(exit).rejects.toThrow(DockerContainerDisappearedError);
    },
    TIMEOUT,
  );
});

// ─── stopContainer ──────────────────────────────────────────

describeRequiresDocker("stopContainer", () => {
  it(
    "stops a running container",
    async () => {
      const id = await createRawContainer(["sleep", "60"]);
      await startContainer(id);

      let res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      let data = (await res.json()) as any;
      expect(data.State.Running).toBe(true);

      // No grace argument: `t` is Docker's MAXIMUM wait before SIGKILL, not a
      // fixed delay, and `sleep` dies on SIGTERM at once — so the shared
      // SIGTERM_GRACE_SECONDS costs this test nothing.
      await stopContainer(id);

      res = await fetch(`${DOCKER_URL}/containers/${id}/json`);
      data = (await res.json()) as any;
      expect(data.State.Running).toBe(false);
    },
    TIMEOUT,
  );
});

// ─── removeContainer ────────────────────────────────────────

describeRequiresDocker("removeContainer", () => {
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

// ─── createNetwork ──────────────────────────────────────────

describeRequiresDocker("createNetwork", () => {
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

describeRequiresDocker("connectContainerToNetwork", () => {
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

describeRequiresDocker("removeNetwork", () => {
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

// ─── cleanupOrphanedContainers ──────────────────────────────

describeRequiresDocker("cleanupOrphanedContainers", () => {
  it(
    "reclaims terminal containers and orphan networks",
    async () => {
      // Two managed containers that have run to completion — inert residue.
      const id1 = await createRawContainer(["true"]);
      const id2 = await createRawContainer(["true"]);
      await startContainer(id1);
      await startContainer(id2);
      await waitForExit(id1);
      await waitForExit(id2);

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
    "preserves a running managed container while reclaiming a terminal one (#1130)",
    async () => {
      // The regression: `appstrate.managed=true` is shared by every instance
      // on the daemon, so a boot sweep that force-removes everything carrying
      // it kills a sibling instance's live agent and sidecar mid-run.
      const live = await createRawContainer(["sleep", "60"]);
      const residue = await createRawContainer(["true"]);
      await startContainer(live);
      await startContainer(residue);
      await waitForExit(residue);

      const result = await cleanupOrphanedContainers();

      // The terminal one is gone...
      const residueRes = await fetch(`${DOCKER_URL}/containers/${residue}/json`);
      expect(residueRes.status).toBe(404);
      untrackContainer(residue);
      expect(result.containers).toBeGreaterThanOrEqual(1);

      // ...and the running one is untouched, still running.
      const liveRes = await fetch(`${DOCKER_URL}/containers/${live}/json`);
      expect(liveRes.status).toBe(200);
      const liveState = (await liveRes.json()) as { State: { Status: string } };
      expect(liveState.State.Status).toBe("running");
    },
    TIMEOUT,
  );

  it(
    "preserves a freshly created container that has never started (#1130)",
    async () => {
      // A sibling instance sits in `created` between createWorkload and
      // startWorkload. `POST /stop` on such a container returns 304 and
      // leaves it `created`, so it can never be made terminal — only the
      // boot-deadline age check may reclaim it, and a fresh one is far
      // below that threshold.
      const provisioning = await createRawContainer(["sleep", "60"]);

      await cleanupOrphanedContainers();

      const res = await fetch(`${DOCKER_URL}/containers/${provisioning}/json`);
      expect(res.status).toBe(200);
      const state = (await res.json()) as { State: { Status: string } };
      expect(state.State.Status).toBe("created");
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

describeRequiresDocker("cleanupOrphanedNetworks", () => {
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

  // Regression #834: the sweep used to also match `appstrate-egress` by
  // name, so a second API process booting against the same daemon deleted
  // the shared egress network out from under the first one's live runs.
  // The egress network is durable infra — never swept.
  it(
    "leaves the shared egress network alone (#834)",
    async () => {
      await cleanupOrphanedNetworks();

      const execOrphan = await createNetwork(`appstrate-exec-orphan-${uid()}`);
      // Simulate the shared infra network the orchestrator stands up at boot.
      const egress = await ensureNetwork(EGRESS_NETWORK_NAME);
      trackNetwork(egress);

      const reclaimed = await cleanupOrphanedNetworks();
      expect(reclaimed).toBeGreaterThanOrEqual(1);

      const execGone = await fetch(`${DOCKER_URL}/networks/${execOrphan}`);
      expect(execGone.status).toBe(404);

      const egressStill = await fetch(`${DOCKER_URL}/networks/${egress}`);
      expect(egressStill.status).toBe(200);
    },
    TIMEOUT,
  );
});

// ─── ensureNetwork ───────────────────────────────────────────

describeRequiresDocker("ensureNetwork", () => {
  it(
    "creates the network when absent and returns its ID",
    async () => {
      const name = `appstrate-test-ensure-${uid()}`;
      const id = trackNetwork(await ensureNetwork(name));

      const res = await fetch(`${DOCKER_URL}/networks/${id}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { Name: string };
      expect(data.Name).toBe(name);
    },
    TIMEOUT,
  );

  it(
    "is idempotent — returns the existing network's ID without recreating",
    async () => {
      const name = `appstrate-test-ensure-${uid()}`;
      const first = trackNetwork(await ensureNetwork(name));
      const second = await ensureNetwork(name);

      expect(second).toBe(first);
    },
    TIMEOUT,
  );

  it(
    "self-heals after the network is deleted under a live process (#834)",
    async () => {
      // Repro of the issue: resolve once (boot), delete the network out of
      // band (`docker network rm` / concurrent instance shutdown), resolve
      // again at next use — must yield a fresh, working network instead of
      // a stale ID that 404s every subsequent container create.
      const name = `appstrate-test-ensure-${uid()}`;
      const staleId = await ensureNetwork(name);
      await removeNetwork(staleId);

      const freshId = trackNetwork(await ensureNetwork(name));
      expect(freshId).not.toBe(staleId);

      const res = await fetch(`${DOCKER_URL}/networks/${freshId}`);
      expect(res.status).toBe(200);
    },
    TIMEOUT,
  );

  it(
    "converges concurrent callers onto a single network (create race)",
    async () => {
      // Two API processes booting simultaneously both ensure the egress
      // network; the 409 loser must adopt the winner's network via
      // re-inspect, not fail the boot.
      const name = `appstrate-test-ensure-${uid()}`;
      const ids = await Promise.all([
        ensureNetwork(name),
        ensureNetwork(name),
        ensureNetwork(name),
        ensureNetwork(name),
      ]);
      trackNetwork(ids[0]!);

      expect(new Set(ids).size).toBe(1);
    },
    TIMEOUT,
  );
});

// ─── Full lifecycle ─────────────────────────────────────────

describeRequiresDocker("Full lifecycle", () => {
  it("create -> start -> streamLogs -> waitForExit -> remove", async () => {
    const id = await createRawContainer(["sh", "-c", 'echo "hello $GREETING"'], {
      env: ["GREETING=world"],
    });

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

// ─── Docker Volume operations ───────────────────────────────

describeRequiresDocker("createVolume / removeVolume", () => {
  it(
    "creates a volume with the appstrate.managed label and removes it",
    async () => {
      const name = `${WORKSPACE_VOLUME_PREFIX}create-${uid()}`;
      trackVolume(name);
      const created = await createVolume(name, { labels: { "appstrate.run": "vol-test" } });
      expect(created).toBe(name);

      const inspect = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(name)}`);
      expect(inspect.ok).toBe(true);
      const body = (await inspect.json()) as { Labels: Record<string, string> };
      expect(body.Labels["appstrate.managed"]).toBe("true");
      expect(body.Labels["appstrate.run"]).toBe("vol-test");

      await removeVolume(name);
      const gone = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(name)}`);
      expect(gone.status).toBe(404);
    },
    TIMEOUT,
  );

  it(
    "is idempotent — removing an absent volume does not throw (404 swallowed)",
    async () => {
      await expect(
        removeVolume(`${WORKSPACE_VOLUME_PREFIX}missing-${uid()}`),
      ).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "accepts tmpfs driver options and creates a RAM-backed volume",
    async () => {
      const name = `${WORKSPACE_VOLUME_PREFIX}tmpfs-${uid()}`;
      trackVolume(name);
      await createVolume(name, {
        labels: { "appstrate.run": "tmpfs-test" },
        driverOpts: { type: "tmpfs", device: "tmpfs", o: "size=4m" },
      });
      const inspect = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(name)}`);
      expect(inspect.ok).toBe(true);
      const body = (await inspect.json()) as { Options?: Record<string, string> };
      expect(body.Options?.type).toBe("tmpfs");
      expect(body.Options?.o).toContain("size=4m");
    },
    TIMEOUT,
  );
});

describeRequiresDocker("cleanupOrphanedVolumes", () => {
  it(
    "reclaims appstrate-ws-* volumes without touching unrelated ones",
    async () => {
      // Pre-condition: clear any leftovers from earlier runs.
      await cleanupOrphanedVolumes();

      const orphan1 = await createVolume(`${WORKSPACE_VOLUME_PREFIX}orphan-${uid()}`);
      const orphan2 = await createVolume(`${WORKSPACE_VOLUME_PREFIX}orphan-${uid()}`);
      const bystander = await createVolume(`appstrate-test-keepme-${uid()}`);
      trackVolume(bystander);

      const reclaimed = await cleanupOrphanedVolumes();
      expect(reclaimed).toBeGreaterThanOrEqual(2);

      for (const name of [orphan1, orphan2]) {
        const res = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(name)}`);
        expect(res.status).toBe(404);
      }
      const stillThere = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(bystander)}`);
      expect(stillThere.status).toBe(200);
    },
    TIMEOUT,
  );
});

describeRequiresDocker("cleanupOrphanedContainers includes volumes in report", () => {
  it(
    "reports container + network + volume counts",
    async () => {
      await cleanupOrphanedContainers();

      const orphanVol = await createVolume(`${WORKSPACE_VOLUME_PREFIX}report-${uid()}`);
      const report = await cleanupOrphanedContainers();

      expect(report.volumes).toBeGreaterThanOrEqual(1);
      const gone = await fetch(`${DOCKER_URL}/volumes/${encodeURIComponent(orphanVol)}`);
      expect(gone.status).toBe(404);
    },
    TIMEOUT,
  );
});

describeRequiresDocker("runEphemeralCommand", () => {
  it(
    "runs a one-shot busybox container, exits zero, auto-removes",
    async () => {
      // Use the same image we already pull elsewhere — keeps the test
      // fast on a warm Docker daemon.
      await expect(runEphemeralCommand({ image: IMAGE, cmd: ["true"] })).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "throws on non-zero exit with the exit code in the message",
    async () => {
      await expect(
        runEphemeralCommand({ image: IMAGE, cmd: ["sh", "-c", "exit 7"] }),
      ).rejects.toThrow(/exit.*7/);
    },
    TIMEOUT,
  );

  it(
    "chowns a volume so a non-root UID can write to it (workspace init pattern)",
    async () => {
      const volName = `${WORKSPACE_VOLUME_PREFIX}chown-${uid()}`;
      trackVolume(volName);
      await createVolume(volName);

      // 1. Init: chown to UID 1001 (the agent's `pi` user — same
      // pattern the docker orchestrator uses on createIsolationBoundary).
      // The marker file is required: Docker resets the mount-point
      // uid:gid on subsequent remounts of an otherwise-empty volume,
      // so we pin the chown by anchoring it to a real file.
      await runEphemeralCommand({
        image: IMAGE,
        cmd: ["sh", "-c", "touch /mnt/.init && chown 1001:1001 /mnt /mnt/.init"],
        binds: [`${volName}:/mnt`],
      });

      // 2. Verify by re-mounting the volume in a second container and
      // reading the numeric owner from `stat`. A separate container
      // exercises the same code path the agent would: chown writes
      // persist across mounts.
      const probeName = `appstrate-test-stat-${uid()}`;
      const createRes = await fetch(`${DOCKER_URL}/containers/create?name=${probeName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Image: IMAGE,
          // `sh -c` so we can chain commands and surface stat output
          // unambiguously (a bare `stat` Cmd works too but logs sometimes
          // race with container teardown — wrapping in sh + sleep is the
          // belt-and-suspenders pattern used elsewhere in this file).
          Cmd: ["sh", "-c", "stat -c '%u:%g' /mnt; sleep 0.1"],
          HostConfig: { Binds: [`${volName}:/mnt`], AutoRemove: false },
        }),
      });
      expect(createRes.ok).toBe(true);
      const probeId = trackContainer(((await createRes.json()) as { Id: string }).Id);
      await startContainer(probeId);
      await waitForExit(probeId);
      // streamLogs after wait → exit code observable + log buffer flushed.
      const out: string[] = [];
      for await (const line of streamLogs(probeId)) out.push(line);
      expect(out.join("").trim()).toContain("1001:1001");
    },
    TIMEOUT,
  );
});

// ─── ensureImagePin ─────────────────────────────────────────
//
// Pin containers are what stop a host-level `docker image prune -a` from
// deleting the runtime images between runs (the deletion that puts a
// multi-hundred-MB pull back on the run-boot critical path). Two invariants
// matter and are both load-bearing:
//   1. the pin converges — same image is a no-op, a drifted image is replaced
//      (releases bump the tag, pins must follow or they protect nothing);
//   2. the pin is NOT reaped by the per-run orphan sweep — it is durable
//      infra, and the sweep force-removes everything labelled
//      `appstrate.managed=true`.

describeRequiresDocker("ensureImagePin", () => {
  const SLOT = `test-${uid()}`;
  const PIN_NAME = `${IMAGE_PIN_PREFIX}${SLOT}`;
  const OTHER_IMAGE = "busybox:1.37";

  async function inspectPin(): Promise<{
    running: boolean;
    labels: Record<string, string>;
  } | null> {
    const res = await fetch(`${DOCKER_URL}/containers/${PIN_NAME}/json`);
    if (res.status === 404) return null;
    const data = (await res.json()) as {
      State?: { Running?: boolean };
      Config?: { Labels?: Record<string, string> };
    };
    return { running: data.State?.Running === true, labels: data.Config?.Labels ?? {} };
  }

  afterEach(async () => {
    const res = await fetch(`${DOCKER_URL}/containers/${PIN_NAME}?force=true`, {
      method: "DELETE",
    });
    void res;
  });

  it(
    "creates a running pin holding the image, and is idempotent",
    async () => {
      await pullImage(IMAGE);

      expect(await ensureImagePin(IMAGE, SLOT)).toBe("created");
      const pin = await inspectPin();
      expect(pin?.running).toBe(true);
      expect(pin?.labels["appstrate.pin.image"]).toBe(IMAGE);
      // Durable infra must not carry the per-run reaper's label.
      expect(pin?.labels["appstrate.managed"]).toBeUndefined();

      // Converged — a second pass must not churn the container.
      expect(await ensureImagePin(IMAGE, SLOT)).toBe("unchanged");
    },
    TIMEOUT,
  );

  it(
    "replaces a pin whose image reference drifted",
    async () => {
      await pullImage(IMAGE);
      await pullImage(OTHER_IMAGE);
      await ensureImagePin(IMAGE, SLOT);

      // What a release bump looks like: PI_IMAGE now points elsewhere and the
      // old pin protects an image nothing launches any more.
      expect(await ensureImagePin(OTHER_IMAGE, SLOT)).toBe("replaced");
      const pin = await inspectPin();
      expect(pin?.labels["appstrate.pin.image"]).toBe(OTHER_IMAGE);
      expect(pin?.running).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "survives the orphaned-container sweep",
    async () => {
      await pullImage(IMAGE);
      await ensureImagePin(IMAGE, SLOT);

      await cleanupOrphanedContainers();

      // Still there: the sweep only reaps `appstrate.managed=true`. If this
      // ever fails, every API boot silently unpins the runtime images.
      const pin = await inspectPin();
      expect(pin).not.toBeNull();
      expect(pin?.running).toBe(true);
    },
    TIMEOUT,
  );
});
