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

import { join, normalize, posix } from "node:path";

import { SubprocessTransport } from "@appstrate/mcp-transport";

import { logger } from "./logger.ts";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";
import {
  buildMitmEnvBlock,
  registerIntegrationRuntimeAdapter,
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
  python: "appstrate-mcp-runner-python:latest",
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
  const t = spec.manifest.server.type;
  const image = RUNNER_IMAGE_BY_TYPE[t];
  if (!image) {
    throw new Error(
      `integration-runtime-adapter-docker: server.type "${t}" has no runner image. ` +
        `Supported types: ${Object.keys(RUNNER_IMAGE_BY_TYPE).join(", ")}`,
    );
  }
  const entry = spec.manifest.server.entryPoint;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-docker: server.entryPoint required for server.type="${t}"`,
    );
  }
  // Path-traversal guard on the host-side path. We still re-derive the
  // container-side path below — this check exists so a malformed
  // manifest can't trick us into docker-cp'ing outside the bundle root.
  const absHostEntry = normalize(join(bundleRoot, entry));
  if (!absHostEntry.startsWith(bundleRoot + posix.sep) && absHostEntry !== bundleRoot) {
    throw new Error(`integration-runtime-adapter-docker: server.entryPoint escapes bundle root`);
  }
  const rel = entry.replace(/^\.?\/+/, "");
  const containerEntry = posix.join("/bundle", rel);
  return { image, containerEntry };
}

async function killContainer(containerId: string): Promise<void> {
  // SIGKILL rather than `stop` — the integration MCP server's only
  // contract is to read JSON-RPC from stdin; graceful SIGTERM gives
  // nothing back and `--rm` cleans up either way. Errors are swallowed:
  // cleanup runs in shutdown paths where the orphan reaper is the
  // safety net.
  await dockerExec(["kill", containerId]).catch(() => {});
}

/**
 * Single `docker info` roundtrip cached per process. The sidecar IS
 * per-run, so this is effectively a one-shot probe at boot.
 */
let dockerAvailableCache: boolean | null = null;
async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailableCache !== null) return dockerAvailableCache;
  try {
    await dockerExec(["info", "--format", "{{.ServerVersion}}"]);
    dockerAvailableCache = true;
  } catch {
    dockerAvailableCache = false;
  }
  return dockerAvailableCache;
}

export function createDockerIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
  const containerIds: string[] = [];
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
      const { runId, spec, bundleRoot, mitm, onStderrLine } = options;
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
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "docker",
  // High priority — when a docker daemon is reachable, container
  // isolation is the production default.
  priority: 100,
  isAvailable: isDockerAvailable,
  create: createDockerIntegrationRuntimeAdapter,
});
