// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { pickOperatorSidecarEnv } from "@appstrate/runner-pi";
import type {
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import * as docker from "../docker.ts";
import { createNetworkWithPoolRetry } from "../docker-errors.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { SIDECAR_MEMORY_BYTES, SIDECAR_NANO_CPUS } from "./constants.ts";
import { applySpecToSidecarEnv } from "./sidecar-env.ts";

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
 * `createContainer` options: the socket bind + `user: "0:0"` when
 * integrations are present, otherwise an empty object (defaults apply).
 */
export function sidecarSocketOverrides(
  spec: Pick<SidecarLaunchSpec, "integrations">,
): { binds: string[]; user: string } | Record<string, never> {
  const hasIntegrations = spec.integrations !== undefined && spec.integrations.length > 0;
  return hasIntegrations
    ? {
        binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        user: "0:0",
      }
    : {};
}

export class DockerOrchestrator implements ContainerOrchestrator {
  private egressNetworkId: string | null = null;
  /**
   * Set of sidecar container IDs whose exit is expected (run is being
   * torn down). The {@link watchSidecarExit} watcher consults this set
   * to suppress the "sidecar exited unexpectedly" log on the cleanup
   * path. Added in {@link stopWorkload}, consumed by the watcher, and
   * defensively cleared in {@link removeWorkload} / {@link shutdown}.
   */
  private expectedSidecarExits = new Set<string>();

  async initialize(): Promise<void> {
    // Ensure runtime images are present (may have been pruned by host cleanup).
    // Use ensureImage (not pullImage) so locally-built / custom-tagged images
    // aren't re-pulled. Pulling once at boot amortises a 20–45 s cold pull off
    // the first run's critical path — the agent's own Bun cold start (~1 s)
    // already masks the warm-image sidecar boot, so a pre-warmed pool buys
    // nothing extra on the user-visible latency.
    const env = getEnv();
    const [, , , egressId] = await Promise.all([
      docker.ensureImage(env.PI_IMAGE),
      docker.ensureImage(env.SIDECAR_IMAGE),
      docker.detectPlatformNetwork(),
      docker.createNetwork("appstrate-egress"),
    ]);
    this.egressNetworkId = egressId;
  }

  async shutdown(): Promise<void> {
    if (this.egressNetworkId) {
      await docker.removeNetwork(this.egressNetworkId).catch(() => {});
      this.egressNetworkId = null;
    }
    // Drop any residual entries — long-lived API processes accumulate
    // one per timed-out / aborted run because `removeWorkload` always
    // re-adds after `stopWorkload` consumed the watcher's match.
    this.expectedSidecarExits.clear();
  }

  async ensureImages(images: string[]): Promise<void> {
    await Promise.all(images.map((image) => docker.ensureImage(image)));
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    const { containers, networks, volumes } = await docker.cleanupOrphanedContainers();
    return { workloads: containers, isolationBoundaries: networks, workspaces: volumes };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    const env = getEnv();
    const name = `${docker.EXEC_NETWORK_PREFIX}${runId}`;
    const volumeName = `${docker.WORKSPACE_VOLUME_PREFIX}${runId}`;

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
        () => docker.cleanupOrphanedRunNetworks(),
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
          ...(env.WORKSPACE_TMPFS_SIZE_MB > 0
            ? {
                driverOpts: {
                  type: "tmpfs",
                  device: "tmpfs",
                  o: `size=${env.WORKSPACE_TMPFS_SIZE_MB}m`,
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

    // Chown the freshly created volume to the agent's `pi` user (UID
    // 1001 — see runtime-pi/Dockerfile L144 `adduser ... -u 1001 pi`,
    // contract-locked by the workspace volume tests in
    // apps/api/test/integration/services/docker-api.test.ts). Docker
    // named volumes default to root-owned on first mount, which
    // would block the agent from writing to /workspace. A one-shot
    // busybox container with the volume mounted is the canonical
    // pattern: cheap (cached image, ~150ms warm), portable across
    // drivers, and avoids baking workspace setup into the agent
    // image's startup path.
    //
    // Subtle Docker quirk: `chown` against the mount-point root only
    // sticks across remounts when the volume has at least one file
    // inside (otherwise Docker resets the mount-point uid:gid from
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
      await Promise.allSettled([docker.removeNetwork(networkId), docker.removeVolume(volumeName)]);
      throw err;
    }

    return {
      id: networkId,
      name,
      workspace: { kind: "volume", name: volumeName },
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
    const [platformApiUrl, platformNetwork] = await Promise.all([
      this.resolvePlatformApiUrl(),
      docker.detectPlatformNetwork(),
    ]);

    const sidecarEnv: Record<string, string> = {
      PORT: "8080",
      ...pickOperatorSidecarEnv(),
      RUN_TOKEN: spec.runToken,
      // Phase 1.4 — exposed so the sidecar can stamp `appstrate.run=<runId>`
      // on integration runner containers it spawns, letting the platform's
      // orphan reaper match them back to the parent run.
      RUN_ID: runId,
      PLATFORM_API_URL: platformApiUrl,
      // Workspace handle the sidecar passes to the integration runtime
      // adapter so runner containers opting in via mcp-server
      // `_meta["dev.appstrate/workspace"]` can mount the same surface as
      // the agent. Shape is the WorkspaceHandle discriminated union —
      // sidecar branches on `kind` (volume vs directory) so a future
      // orchestrator can introduce a third shape without touching
      // adapter dispatch.
      WORKSPACE_HANDLE_JSON: JSON.stringify(boundary.workspace),
    };
    applySpecToSidecarEnv(spec, sidecarEnv);
    // The sidecar selects its integration runtime purely from this var (no
    // auto-detection). Pin it to mirror this orchestrator's RUN_ADAPTER so a
    // containerized run spawns its integrations as containers too. Respect an
    // explicit operator override carried in from the environment.
    sidecarEnv.INTEGRATION_RUNTIME_ADAPTER = process.env.INTEGRATION_RUNTIME_ADAPTER ?? "docker";

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
      networkId: this.egressNetworkId!,
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
    const platformNetwork = spec.egress ? await docker.detectPlatformNetwork() : null;

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
      networkId: spec.egress ? this.egressNetworkId! : boundary.id,
      networkAlias: spec.role,
      ...(workspaceBinds.length > 0 ? { binds: workspaceBinds } : {}),
      ...(spec.egress
        ? { extraHosts: platformNetwork ? [] : ["host.docker.internal:host-gateway"] }
        : {}),
    });

    if (spec.egress && platformNetwork) {
      await docker.connectContainerToNetwork(platformNetwork.networkId, containerId);
    }

    if (spec.files && spec.files.items.length > 0) {
      await docker.injectFiles(containerId, spec.files.items, spec.files.targetDir);
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
