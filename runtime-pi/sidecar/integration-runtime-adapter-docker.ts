// SPDX-License-Identifier: Apache-2.0

/**
 * Docker-backed integration runtime adapter.
 *
 * One runner container per integration, on the per-run user-defined
 * bridge network (`appstrate-exec-<runId>`, created by the platform
 * launcher with the sidecar joined under the `sidecar` DNS alias).
 * MITM listeners bind 0.0.0.0 so the runner reaches them via
 * `http://sidecar:<port>`. CA cert is `docker cp`'d into the runner
 * at {@link CA_CONTAINER_PATH}.
 */

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, join } from "node:path";

import { SubprocessTransport } from "@appstrate/mcp-transport";

import { logger } from "./logger.ts";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";
import {
  buildMitmEnvBlock,
  isPathSafeForMount,
  registerIntegrationRuntimeAdapter,
  resolveBundleEntry,
  WORKSPACE_ENV_VAR,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type SpawnIntegrationOptions,
  type SpawnedIntegration,
} from "./integration-runtime-adapter.ts";

/**
 * Map MCPB-compatible `server.type` to the Appstrate runner image. The
 * runner image carries the language interpreter; the sidecar's own
 * image carries none. Adding a new runtime is one map entry here + one
 * `runtime-pi/runners/{name}/Dockerfile`.
 */
const RUNNER_IMAGE_BY_TYPE: Record<string, string> = {
  node: "appstrate-mcp-runner-node:latest",
  // In process mode `bun` runs as a host subprocess; in docker mode it gets
  // its own container here, like every other runtime — keeps tier-3's
  // cgroup/cap-drop/network isolation (the sidecar runs as root with the
  // Docker socket mounted, so third-party bun code never shares its process).
  bun: "appstrate-mcp-runner-bun:latest",
  python: "appstrate-mcp-runner-python:latest",
  // MCPB 0.4 / AFPS §3.4 — `uv` runs Python through Astral's `uv`
  // resolver. Dedicated image built on `ghcr.io/astral-sh/uv:python3.12-alpine`
  // so `uv run` is on PATH and can materialise per-bundle venvs from
  // pyproject.toml / requirements.txt / PEP-723 inline metadata.
  uv: "appstrate-mcp-runner-uv:latest",
  binary: "appstrate-mcp-runner-binary:latest",
};

/**
 * Path inside the runner container where the run-CA cert lands. `/tmp`
 * is guaranteed to exist on every runner image; `docker cp` does NOT
 * create parent directories on the destination side, so anything
 * pointing at a non-existent dir (e.g. `/etc/appstrate/`) would fail
 * with `Could not find the file <parent> in container`, silently
 * breaking every HTTP-delivery integration on the run. The standard
 * trust-store env vars accept arbitrary paths — they don't care.
 */
const CA_CONTAINER_PATH = "/tmp/appstrate-ca.pem";

interface ContainerPlan {
  image: string;
  /** Path inside the runner the entrypoint executes (passed as CMD). */
  containerEntry: string;
}

interface DockerExecSubprocess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

type DockerExecSpawn = (
  cmd: string[],
  opts: { stdin: "ignore"; stdout: "pipe"; stderr: "pipe" },
) => DockerExecSubprocess;

async function dockerExec(args: string[]): Promise<string> {
  const bunSpawn = (globalThis as unknown as { Bun?: { spawn?: DockerExecSpawn } }).Bun?.spawn;
  if (!bunSpawn) throw new Error("integration-runtime-adapter-docker: Bun.spawn unavailable");
  const proc = bunSpawn(["docker", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}

function planContainer(spec: IntegrationSpawnSpec, bundleRoot: string): ContainerPlan {
  const server = spec.manifest.server;
  if (!server) {
    throw new Error("integration-runtime-adapter-docker: spec has no server to spawn");
  }
  const t = server.type;
  if (!t) {
    throw new Error(
      "integration-runtime-adapter-docker: server.type required for local-source spawn",
    );
  }
  const image = RUNNER_IMAGE_BY_TYPE[t];
  if (!image) {
    throw new Error(
      `integration-runtime-adapter-docker: server.type "${t}" has no runner image. ` +
        `Supported types: ${Object.keys(RUNNER_IMAGE_BY_TYPE).join(", ")}`,
    );
  }
  const entry = server.entry_point;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-docker: server.entry_point required for server.type="${t}"`,
    );
  }
  // Path-traversal guard on the host-side path. We still re-derive the
  // container-side path below — this check exists so a malformed
  // manifest can't trick us into docker-cp'ing outside the bundle root.
  resolveBundleEntry(bundleRoot, entry);
  const rel = entry.replace(/^\.?\/+/, "");
  const containerEntry = posix.join("/bundle", rel);
  return { image, containerEntry };
}

async function killContainer(containerId: string): Promise<void> {
  // `rm -f` instead of `kill`: a container that crashed between
  // `docker create` and `docker start -ai` (e.g. `docker cp` failed
  // while staging the bundle) is in the `created` state with no PID 1,
  // so `docker kill` returns an error and `--rm` never fires (it only
  // triggers on container *exit*). `rm -f` works on any state and
  // collapses the kill+remove into one call. Errors stay swallowed —
  // the orphan reaper (label `appstrate.managed=true`) is the safety
  // net for sidecar crashes.
  await dockerExec(["rm", "-f", containerId]).catch(() => {});
}

/**
 * AFPS §7.6 (CC-5) — materialise a `delivery.files` entry into the
 * runner container. Writes the decoded bytes to a sidecar-local temp file
 * with the requested POSIX mode, then `docker cp`'s it into the container
 * at the absolute manifest path. Returns the host temp file path so the
 * caller can clean up after spawn.
 *
 * Security:
 *   - The container path is the manifest-declared key. The platform-side
 *     resolver enforces absolute-POSIX + no `..` + non-root (see
 *     `isSafeDeliveryFilePath`) before this code ever runs, so the value
 *     reaching us is structurally safe.
 *   - The host temp file lives in `os.tmpdir()/appstrate-files-<random>/`
 *     and is unlinked after the cp completes (the per-integration
 *     `materializeFileMounts` collector handles cleanup).
 *   - `docker cp` does NOT create parent directories on the destination
 *     side. We pre-create the parent inside the container via
 *     `docker exec mkdir -p` so manifest paths like
 *     `/run/creds/cert.pem` work without operators having to image the
 *     full directory tree.
 */
/**
 * R8a — reject container destination paths that escape the runner's safe
 * writable area. The platform-side resolver (`isSafeDeliveryFilePath`)
 * already rejects relative + `..` traversal + NUL bytes + pure root, so by
 * the time we get here `containerPath` is structurally a safe absolute
 * POSIX path. The extra check below adds a second floor: top-level system
 * directories the runner has no business mutating from credential mounts.
 *
 * Rejected prefixes:
 *   - `/dev/`, `/proc/`, `/sys/` — kernel-managed; mounting credentials
 *     there would corrupt the running container, not write a file.
 *   - `/etc/passwd*`, `/etc/shadow*`, `/etc/sudoers*` — privilege escalation
 *     surface; even if the runner is `--cap-drop ALL`, mounting over these
 *     is operator error worth refusing loudly.
 *   - `/.docker/`, `/.dockerenv` — Docker-private surfaces.
 */
export function isContainerPathSafeForMount(containerPath: string): boolean {
  // Shared floor + Docker-private surfaces: `/.docker/` (prefix) and
  // `/.dockerenv` (file) on top of the kernel-managed +
  // privilege-escalation floor enforced by `isPathSafeForMount`.
  return isPathSafeForMount(containerPath, {
    extraForbiddenPrefixes: ["/.docker/"],
    extraForbiddenFiles: ["/.dockerenv"],
  });
}

async function materializeFileMountsInContainer(
  containerId: string,
  fileMounts: Record<string, { content_b64: string; mode: string }>,
): Promise<string[]> {
  const hostTempFiles: string[] = [];
  // One temp dir per spawn, cleaned up by the caller after cp completes.
  const tempDir = await mkdtemp(join(tmpdir(), "appstrate-files-"));
  hostTempFiles.push(tempDir);

  for (const [containerPath, entry] of Object.entries(fileMounts)) {
    // R8a — refuse paths into kernel-managed / privilege-escalation
    // surfaces. The platform-side validator already strips `..` /
    // relative paths; this is the second floor.
    if (!isContainerPathSafeForMount(containerPath)) {
      throw new Error(
        `integration-runtime-adapter-docker: refused to mount credential file at unsafe container path ${containerPath}`,
      );
    }
    // Decode bytes from the base64 wire form.
    const bytes = Buffer.from(entry.content_b64, "base64");
    // Random host-side filename — the container path is reconstructed
    // separately, so we don't leak the manifest path into the host fs.
    const hostFile = join(tempDir, `f-${hostTempFiles.length}`);
    await writeFile(hostFile, bytes);
    // chmod on the host side so the runner reads the file with the
    // requested mode after `docker cp` (cp preserves perms from source).
    const modeOctal = parseInt(entry.mode, 8);
    if (!Number.isNaN(modeOctal)) {
      await chmod(hostFile, modeOctal);
    }
    // R8a — pre-create the parent dir inside the container so `docker cp`
    // succeeds when the manifest path goes deeper than the runner image's
    // baked-in tree (e.g. `/etc/appstrate/certs/`). The container is in
    // `Created` state before `docker start`; `docker exec` against it works
    // since Docker 1.13 (exec runs `runc exec` which doesn't require the
    // PID 1 process to be live — it creates a new process namespace
    // member). We swallow errors (some older runtimes refuse exec on a
    // not-yet-started container) and fall back to the historical behaviour
    // where `docker cp` itself errors out — the run boot then fails fast
    // with a clear message that surfaces in the boot report.
    const parent = posix.dirname(containerPath);
    if (parent !== "/" && parent !== ".") {
      // `mkdir -p` is idempotent and works on every base image
      // (busybox/alpine/slim). Using `--user 0` would require an
      // elevated runner; we accept the default user (`node` / `python`
      // / `nobody` depending on image) — the runner has write
      // permissions to its own writable layer regardless.
      await dockerExec(["exec", containerId, "mkdir", "-p", parent]).catch(() => {
        // Older docker / not-yet-started container: ignore. The
        // subsequent `docker cp` will surface the missing-parent error
        // itself if the directory truly doesn't exist.
      });
    }
    await dockerExec(["cp", hostFile, `${containerId}:${containerPath}`]);
  }

  return hostTempFiles;
}

export function createDockerIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
  const containerIds: string[] = [];
  /** Per-spawn host temp directories holding decoded fileMounts bytes. */
  const hostTempDirsByContainer: Map<string, string[]> = new Map();
  let runNetwork: string | null = null;

  return {
    id: "docker",

    async prepare(runId: string): Promise<RuntimeAdapterRunContext> {
      // The per-run docker network is created by the platform launcher
      // (`appstrate-exec-<runId>`) with the sidecar attached under the
      // `sidecar` DNS alias. The runner joins the same network so its
      // HTTPS_PROXY resolves via Docker's embedded DNS. RUN_ID is set
      // on sidecar create; when it's absent (sidecar booted outside
      // the platform launcher's path — dev / tests), we fall back to
      // the default bridge with loopback URLs and skip the alias path.
      const envRunId = process.env.RUN_ID;
      runNetwork = envRunId ? `appstrate-exec-${envRunId}` : null;
      logger.info("docker integration adapter ready", { runId, runNetwork });
      return {
        // Bind 0.0.0.0 when we have a per-run network — the runner
        // reaches the listener via the bridge. Without a network we
        // can't make the listener routable from a sibling container
        // anyway, so 127.0.0.1 is the safe default.
        listenerBindHost: runNetwork ? "0.0.0.0" : "127.0.0.1",
        proxyUrlFor: (port: number) =>
          runNetwork ? `http://sidecar:${port}` : `http://127.0.0.1:${port}`,
      };
    },

    async spawn(options: SpawnIntegrationOptions): Promise<SpawnedIntegration> {
      const { runId, spec, bundleRoot, mitm, workspaceHandle, onStderrLine } = options;
      const plan = planContainer(spec, bundleRoot);
      const safeNs = spec.namespace.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
      const containerName = `appstrate-integ-${safeNs}-${runId.slice(0, 8)}-${Date.now()}`;

      const envFlags: string[] = [];
      for (const [k, v] of Object.entries(spec.spawnEnv)) {
        envFlags.push("-e", `${k}=${v}`);
      }
      if (mitm) {
        for (const [k, v] of Object.entries(buildMitmEnvBlock(mitm.proxyUrl, CA_CONTAINER_PATH))) {
          envFlags.push("-e", `${k}=${v}`);
        }
      }

      // Per-run shared workspace mount. Wired ONLY when the spec's
      // referenced mcp-server opted in via _meta.workspace AND the
      // launching orchestrator carried a workspace handle of the right
      // shape (volume for docker). A volume mismatch (spec says yes,
      // handle says no / wrong-kind) is logged as a warning and the
      // runner spawns without workspace access rather than aborting
      // the run.
      const volumeFlags: string[] = [];
      if (spec.workspaceMount) {
        if (workspaceHandle?.kind === "volume") {
          const roSuffix = spec.workspaceMount.access === "ro" ? ":ro" : "";
          volumeFlags.push("-v", `${workspaceHandle.name}:${spec.workspaceMount.mount}${roSuffix}`);
          envFlags.push("-e", `${WORKSPACE_ENV_VAR}=${spec.workspaceMount.mount}`);
        } else {
          // ERROR-level (not warn): the mcp-server author explicitly
          // opted into a shared workspace via `_meta.workspace` AND
          // the platform's MCP Roots advertisement will tell its
          // protocol client the path is available — but the actual
          // bind is missing. A SOTA mcp-server that caches roots/list
          // would then issue write calls against an unmounted path,
          // failing in ways that look like server bugs rather than
          // misconfig. Surface loudly so operators see it on the
          // first run, not the tenth.
          logger.error(
            "spec declares workspaceMount but launching orchestrator carried no volume handle; runner spawned WITHOUT workspace — opt-in mcp-server tools will fail",
            {
              integrationId: spec.integrationId,
              haveHandle: workspaceHandle?.kind ?? "none",
              declaredMount: spec.workspaceMount.mount,
              declaredAccess: spec.workspaceMount.access,
            },
          );
        }
      }

      const labelFlags: string[] = [
        "--label",
        `appstrate.run=${runId}`,
        "--label",
        "appstrate.managed=true",
        "--label",
        "appstrate.adapter=integration",
        "--label",
        `appstrate.integration=${spec.integrationId}`,
      ];

      const networkFlags: string[] = runNetwork ? ["--network", runNetwork] : [];

      const containerId = await dockerExec([
        "create",
        "--rm",
        "-i",
        "--name",
        containerName,
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--memory",
        "256m",
        "--pids-limit",
        "128",
        ...networkFlags,
        ...volumeFlags,
        ...labelFlags,
        ...envFlags,
        plan.image,
        plan.containerEntry,
      ]);
      containerIds.push(containerId);

      // docker cp <src>/. <id>:/<dst>/  — the trailing `/.` semantics
      // copy the directory's *contents* into /bundle (already exists in
      // the runner image as the WORKDIR), so the runner's entrypoint
      // sees `/bundle/server/index.js` at the path the manifest declared.
      await dockerExec(["cp", `${bundleRoot}/.`, `${containerId}:/bundle/`]);
      if (mitm) {
        await dockerExec(["cp", mitm.caCertHostPath, `${containerId}:${CA_CONTAINER_PATH}`]);
      }

      // AFPS §7.6 (CC-5) — materialise `delivery.files` entries into
      // the runner container BEFORE `docker start -ai` so the entrypoint
      // observes them at boot. The host temp dir is cleaned up by
      // `shutdown()` (we keep the reference so cleanup is exception-safe).
      if (spec.fileMounts && Object.keys(spec.fileMounts).length > 0) {
        const hostTempDirs = await materializeFileMountsInContainer(containerId, spec.fileMounts);
        hostTempDirsByContainer.set(containerId, hostTempDirs);
      }

      // `docker start -ai <id>` starts the entrypoint AND attaches stdio.
      // SubprocessTransport spawns this as a child, pipes the JSON-RPC
      // line stream through, and tears the whole thing down on close().
      // Auto-rm on the container side handles cleanup if we crash without
      // a graceful close.
      const transport = new SubprocessTransport({
        command: "docker",
        args: ["start", "-ai", containerId],
        // `env` is NOT passed to the docker CLI — credentials are baked
        // into the container at create-time via `-e`. The CLI only needs
        // PATH/HOME/DOCKER_HOST to find the daemon socket.
        envPassthrough: ["PATH", "HOME", "DOCKER_HOST"],
        onStderrLine,
      });

      return { transport, diagnosticId: containerId.slice(0, 12) };
    },

    async shutdown(): Promise<void> {
      // Container kill is best-effort — `--rm` will clean up after
      // SubprocessTransport closes the docker-attach stdio anyway. This
      // belt-and-suspenders kill covers servers that ignore stdin EOF.
      for (const id of containerIds) {
        await killContainer(id);
      }
      containerIds.length = 0;
      // AFPS §7.6 (CC-5) — clean up host-side temp files holding
      // decoded `delivery.files` bytes. Best-effort: if the dir is gone
      // (already cleaned, container's own --rm removed it, …) we skip.
      for (const dirs of hostTempDirsByContainer.values()) {
        for (const dir of dirs) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
      hostTempDirsByContainer.clear();
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "docker",
  create: createDockerIntegrationRuntimeAdapter,
});
