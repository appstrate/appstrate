// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
import type {
  RunOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarEndpoints,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import * as docker from "../docker.ts";
import { createNetworkWithPoolRetry } from "../docker-errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_MEMORY_BYTES, SIDECAR_NANO_CPUS } from "./constants.ts";
import { buildBaseSidecarEnv } from "./sidecar-env.ts";

class DockerWorkloadHandle implements WorkloadHandle {
  constructor(
    readonly id: string,
    readonly runId: string,
    readonly role: string,
  ) {}
}

/**
 * Docker socket gating invariant (host-escape boundary).
 *
 * The sidecar only needs the Docker socket + root when it has to spawn
 * per-integration runner containers — i.e. when the run declares ≥1
 * integration. Runs without integrations keep the image's locked-down
 * default (`nobody:nobody`, no socket bind). Extracted as a pure helper so
 * the gating decision is unit-testable without a Docker daemon.
 *
 * Returns the `HostConfig`/`User` overrides to merge into the
 * `createContainer` options: the socket bind + `user: "0:0"` + the
 * low-port sysctl for the transparent egress plane (#779) when
 * integrations are present, otherwise an empty object (defaults apply).
 */
export function sidecarSocketOverrides(
  spec: Pick<SidecarLaunchSpec, "integrations">,
): { binds: string[]; user: string; sysctls: Record<string, string> } | Record<string, never> {
  const hasIntegrations = spec.integrations !== undefined && spec.integrations.length > 0;
  return hasIntegrations
    ? {
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        user: "0:0",
        // #779 — let the sidecar bind :53/:443/:80 on the per-run bridge for
        // its transparent egress plane (DNS responder + SNI-passthrough).
        // Netns-scoped sysctl, not a capability: `CapDrop: ["ALL"]` stays.
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      }
    : {};
}

/**
 * Agent-visible sidecar endpoints on the Docker topology: the sidecar is
 * reachable through its DNS alias on the per-run bridge network. Static —
 * the alias and ports are identical for every run.
 */
const DOCKER_SIDECAR_ENDPOINTS: SidecarEndpoints = {
  sidecarUrl: "http://sidecar:8080",
  llmProxyUrl: "http://sidecar:8080/llm",
  forwardProxyUrl: "http://sidecar:8081",
  noProxy: "sidecar,localhost,127.0.0.1",
};

export class DockerOrchestrator implements RunOrchestrator {
  /**
   * Set of sidecar container IDs whose exit is expected (run is being
   * torn down). The {@link watchSidecarExit} watcher consults this set
   * to suppress the "sidecar exited unexpectedly" log on the cleanup
   * path. Added in {@link stopWorkload}, consumed by the watcher, and
   * defensively cleared in {@link removeWorkload} / {@link shutdown}.
   */
  private expectedSidecarExits = new Set<string>();
  /**
   * Images verified present in this process's lifetime (pre-pulled at
   * {@link initialize} or ensured by a prior run). {@link ensureImages}
   * skips these — the per-run `imageExists` inspect round-trip was pure
   * overhead on the run-boot critical path for images that are pulled
   * once at boot and effectively never disappear mid-lifetime.
   *
   * This cache is an optimisation only, never a correctness assumption: a
   * host image prune between runs invalidates it silently, so the entry
   * can be a lie. Correctness lives one layer down in `createContainer`,
   * which heals a `No such image` 404 by pulling and retrying once — after
   * which the cached "verified" claim is true again. Long-lived API
   * processes therefore self-heal mid-lifetime instead of failing every
   * run until the next restart.
   */
  private verifiedImages = new Set<string>();

  async initialize(): Promise<void> {
    // Ensure runtime images are present (may have been pruned by host cleanup).
    // Use ensureImage (not pullImage) so locally-built / custom-tagged images
    // aren't re-pulled. Pulling once at boot amortises a 20–45 s cold pull off
    // the first run's critical path — the agent's own Bun cold start (~1 s)
    // already masks the warm-image sidecar boot, so a pre-warmed pool buys
    // nothing extra on the user-visible latency.
    const env = getEnv();
    await Promise.all([
      docker.ensureImage(env.PI_IMAGE),
      docker.ensureImage(env.SIDECAR_IMAGE),
      docker.detectPlatformNetwork(),
      // Warm the shared egress network so the first run doesn't pay the
      // create. The ID is deliberately NOT cached: it is re-resolved by
      // name on every use (createSidecar / createWorkload) so the process
      // self-heals when the network disappears mid-lifetime (#834).
      docker.ensureNetwork(docker.EGRESS_NETWORK_NAME),
    ]);
    this.verifiedImages.add(env.PI_IMAGE);
    this.verifiedImages.add(env.SIDECAR_IMAGE);
  }

  async shutdown(): Promise<void> {
    // The egress network is intentionally left in place: it is durable
    // infra shared with any other Appstrate process on this daemon (#834).
    // Removing it here used to break the runs of a concurrently-running
    // instance, whose cached network ID went stale.
    //
    // Drop any residual entries — long-lived API processes accumulate
    // one per timed-out / aborted run because `removeWorkload` always
    // re-adds after `stopWorkload` consumed the watcher's match.
    this.expectedSidecarExits.clear();
  }

  async ensureImages(images: string[]): Promise<void> {
    const missing = images.filter((image) => !this.verifiedImages.has(image));
    if (missing.length === 0) return;
    await Promise.all(missing.map((image) => docker.ensureImage(image)));
    for (const image of missing) this.verifiedImages.add(image);
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const { containers, networks, volumes } = await docker.cleanupOrphanedContainers();
    return { workloads: containers, isolationBoundaries: networks, workspaces: volumes };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    const env = getEnv();
    const name = `${docker.EXEC_NETWORK_PREFIX}${runId}`;
    const volumeName = `${docker.WORKSPACE_VOLUME_PREFIX}${runId}`;
    const useTmpfs = env.WORKSPACE_TMPFS_SIZE_MB > 0;

    // Create the per-run network + workspace volume in parallel — both
    // are independent Docker resources and either may hit pool/quota
    // pressure, so racing them shaves real ms off run boot. Network
    // creation retries on `address pool exhausted`; volume creation
    // pre-reaps any stale `appstrate-ws-<runId>` residue from a hard
    // crash so a name collision can't 409 on a quick-restart loop.
    //
    // `allSettled` (not `all`): with `all`, a reject on one branch
    // resolves the call while the *other* branch's already-created
    // resource is silently orphaned (reclaimed only by the next boot
    // sweep). Settle both, then on any failure tear down whichever
    // succeeded before rethrowing so a partial create leaks nothing.
    const [networkResult, volumeResult] = await Promise.allSettled([
      createNetworkWithPoolRetry(
        () => docker.createNetwork(name, { internal: true }),
        () => docker.cleanupOrphanedNetworks(),
        logger,
      ),
      (async () => {
        // Pre-reap defends against the kill-9-then-immediate-restart
        // window where the orchestrator's `removeIsolationBoundary`
        // never ran. Force-remove any zombie containers labelled with
        // this runId first — Docker 409s on `volume rm` while any
        // container still references it, so a leftover sidecar/agent
        // row from the previous boot would silently block volume
        // creation. The remove is best-effort (404 swallowed).
        await docker.removeContainersByRun(runId).catch(() => {});
        await docker.removeVolume(volumeName).catch(() => {});
        return docker.createVolume(volumeName, {
          labels: { "appstrate.run": runId },
          ...(useTmpfs
            ? {
                // `uid`/`gid` are kernel tmpfs mount options: ownership is
                // set at mount time for the agent's `pi` user (UID 1001 —
                // see runtime-pi/Dockerfile `adduser ... -u 1001 pi`), so
                // the disk path's chown init container (below) is skipped
                // entirely on this branch — a full ephemeral-container
                // lifecycle (~150 ms) off the run-boot critical path.
                driverOpts: {
                  type: "tmpfs",
                  device: "tmpfs",
                  o: `size=${env.WORKSPACE_TMPFS_SIZE_MB}m,uid=1001,gid=1001`,
                },
              }
            : {}),
        });
      })(),
    ]);

    if (networkResult.status === "rejected" || volumeResult.status === "rejected") {
      // One side may have succeeded — reclaim it before propagating.
      await Promise.allSettled([
        networkResult.status === "fulfilled"
          ? docker.removeNetwork(networkResult.value)
          : Promise.resolve(),
        volumeResult.status === "fulfilled" ? docker.removeVolume(volumeName) : Promise.resolve(),
      ]);
      throw networkResult.status === "rejected"
        ? networkResult.reason
        : (volumeResult as PromiseRejectedResult).reason;
    }

    const networkId = networkResult.value;

    // Disk-backed volumes (WORKSPACE_TMPFS_SIZE_MB=0) still need the chown
    // init: Docker local named volumes default to root-owned on first
    // mount, which would block the agent (`pi`, UID 1001 — see
    // runtime-pi/Dockerfile `adduser ... -u 1001 pi`, contract-locked by
    // the workspace volume tests in
    // apps/api/test/integration/services/docker-api.test.ts) from writing
    // to /workspace. A one-shot busybox container with the volume mounted
    // is the canonical pattern: portable across drivers, avoids baking
    // workspace setup into the agent image's startup path. The tmpfs
    // branch (the default) skips this — ownership is set via the volume's
    // `uid`/`gid` mount options at create time above, saving the
    // ephemeral container's full create+start+wait+remove round-trip
    // (~150 ms) on the run-boot critical path.
    //
    // Subtle Docker quirk (disk path): `chown` against the mount-point
    // root only sticks across remounts when the volume has at least one
    // file inside (otherwise Docker resets the mount-point uid:gid from
    // the image's directory metadata on each subsequent mount). The
    // `touch /workspace/.appstrate-init` is the marker file that
    // pins the chown — small, predictable, hidden from agent
    // discovery via the leading dot. Without this marker, the agent
    // sees `/workspace` as root-owned and can't write to its CWD.
    //
    // Failure handling: if the chown step throws (image missing,
    // daemon flake), tear down the freshly-created network + volume
    // BEFORE rethrowing so the orchestrator doesn't leak a half-
    // initialised boundary. The caller never sees the partial
    // resources and the orphan reaper has nothing to do.
    if (!useTmpfs) {
      try {
        await docker.runEphemeralCommand({
          image: env.WORKSPACE_INIT_IMAGE,
          cmd: [
            "sh",
            "-c",
            "touch /workspace/.appstrate-init && chown 1001:1001 /workspace /workspace/.appstrate-init",
          ],
          binds: [`${volumeName}:/workspace`],
          runId,
        });
      } catch (err) {
        await Promise.allSettled([
          docker.removeNetwork(networkId),
          docker.removeVolume(volumeName),
        ]);
        throw err;
      }
    }

    return {
      id: networkId,
      name,
      workspace: { kind: "volume", name: volumeName },
      sidecarEndpoints: DOCKER_SIDECAR_ENDPOINTS,
    };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    // Network and volume teardown are independent — race them so a
    // slow volume delete (e.g. tmpfs scrubbing many small files) doesn't
    // serialize the network reclaim. Failures are swallowed individually
    // so a leaked volume can't prevent the network from being torn down
    // (the orphan reaper picks up either residue on the next sweep).
    await Promise.allSettled([
      docker.removeNetwork(boundary.id),
      boundary.workspace.kind === "volume"
        ? docker.removeVolume(boundary.workspace.name)
        : Promise.resolve(),
    ]);
  }

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    const env = getEnv();
    // Resolve the egress network by name on every use (not a boot-time
    // cached ID): if it vanished mid-lifetime (`docker network prune`,
    // daemon restart, another Appstrate process), ensureNetwork recreates
    // it and the run proceeds instead of 404ing until an API restart (#834).
    const [platformApiUrl, platformNetwork, egressNetworkId] = await Promise.all([
      this.resolvePlatformApiUrl(),
      docker.detectPlatformNetwork(),
      docker.ensureNetwork(docker.EGRESS_NETWORK_NAME),
    ]);

    const sidecarEnv = buildBaseSidecarEnv({
      spec,
      baseEnv: pickOperatorSidecarEnv(),
      port: "8080",
      // Phase 1.4 — RUN_ID lets the sidecar stamp `appstrate.run=<runId>`
      // on the integration runner containers it spawns, letting the
      // platform's orphan reaper match them back to the parent run.
      runId,
      platformApiUrl,
      workspace: boundary.workspace,
    });
    // The sidecar selects its integration runtime purely from this var (no
    // auto-detection). Pin it to mirror this orchestrator's RUN_ADAPTER so a
    // containerized run spawns its integrations as containers too. Respect an
    // explicit operator override — the env schema validates the value and
    // defaults it to "docker".
    sidecarEnv.INTEGRATION_RUNTIME_ADAPTER = env.INTEGRATION_RUNTIME_ADAPTER;

    // Create sidecar on egress network (primary) so it has DNS + internet.
    // Then connect to run network (internal) with "sidecar" alias for agent DNS.
    //
    // When the run declares AFPS integrations, the sidecar needs to spawn
    // per-integration runner containers (`appstrate-mcp-runner-{node,python,
    // binary,bun,uv}`). It shells out to the Docker daemon via the mounted socket
    // + `docker-cli` baked into the sidecar image. Running as root is the
    // simplest portable way to access the socket (group GIDs vary across
    // hosts: Docker Desktop on macOS exposes a 0-owned socket, Linux a
    // `docker`-group one, rootless Docker uses the calling UID). We only
    // grant it when the run actually has integrations — otherwise we keep
    // the sidecar locked down with the image's default `nobody:nobody`.
    const containerId = await docker.createContainer(runId, sidecarEnv, {
      image: env.SIDECAR_IMAGE,
      adapterName: "sidecar",
      memory: SIDECAR_MEMORY_BYTES,
      nanoCpus: SIDECAR_NANO_CPUS,
      networkId: egressNetworkId,
      extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"],
      ...sidecarSocketOverrides(spec),
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
    // Same by-name resolution as createSidecar: never trust a cached
    // network ID across the process lifetime (#834).
    const [platformNetwork, egressNetworkId] = spec.egress
      ? await Promise.all([
          docker.detectPlatformNetwork(),
          docker.ensureNetwork(docker.EGRESS_NETWORK_NAME),
        ])
      : [null, null];

    // Mount the per-run workspace into the agent container at
    // /workspace (already exists as the agent's CWD, chowned to `pi`
    // at image build time). The boundary's init step set the volume's
    // top-level ownership to UID 1001 so the agent can write
    // immediately. Only the `agent` role gets the mount — the sidecar
    // never reads workspace bytes, and other potential roles
    // (debug-shell, etc.) opt in explicitly when introduced.
    const workspaceBinds =
      spec.role === "agent" && boundary.workspace.kind === "volume"
        ? [`${boundary.workspace.name}:/workspace`]
        : [];

    const containerId = await docker.createContainer(spec.runId, spec.env, {
      image: spec.image,
      adapterName: spec.role,
      memory: spec.resources.memoryBytes,
      nanoCpus: spec.resources.nanoCpus,
      pidsLimit: spec.resources.pidsLimit,
      networkId: egressNetworkId ?? boundary.id,
      networkAlias: spec.role,
      ...(workspaceBinds.length > 0 ? { binds: workspaceBinds } : {}),
      ...(spec.egress
        ? { extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"] }
        : {}),
    });

    if (spec.egress && platformNetwork) {
      await docker.connectContainerToNetwork(platformNetwork.networkId, containerId);
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
