// SPDX-License-Identifier: Apache-2.0

/**
 * In-process integration runtime adapter — the universal fallback.
 *
 * Spawns each integration MCP server as a direct subprocess of the
 * sidecar via `Bun.spawn`. No container isolation, no per-run network.
 * The subprocess inherits the sidecar's network namespace, so the MITM
 * listener stays on 127.0.0.1 and the CA cert lives on shared fs.
 *
 * Used in dev (sidecar running as a Bun subprocess on the host) and in
 * tests. In production the docker adapter takes precedence.
 */

import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SubprocessTransport } from "@appstrate/mcp-transport";

import { logger } from "./logger.ts";
import type { IntegrationSpawnSpec } from "./integrations-boot.ts";
import {
  buildMitmEnvBlock,
  registerIntegrationRuntimeAdapter,
  resolveBundleEntry,
  type IntegrationRuntimeAdapter,
  type RuntimeAdapterRunContext,
  type SpawnIntegrationOptions,
  type SpawnedIntegration,
} from "./integration-runtime-adapter.ts";

/**
 * Subprocess-mode interpreter mapping. Symmetric with
 * RUNNER_IMAGE_BY_TYPE in the docker adapter — adding a new runtime
 * requires updating both.
 */
const HOST_INTERPRETER_BY_TYPE: Record<string, { command: string; argsBefore: string[] }> = {
  node: { command: "node", argsBefore: [] },
  // `bun` runs the entry directly (`.ts` / `.js`) — the sidecar's own
  // runtime, always on PATH in process mode. In docker mode the docker
  // adapter runs bun in the `appstrate-mcp-runner-bun` container instead.
  bun: { command: "bun", argsBefore: [] },
  python: { command: "python3", argsBefore: ["-u"] },
  // MCPB 0.4 / AFPS 2.0.2 §3.4 — `uv run <entry>` resolves a project's
  // virtualenv + dependencies on the fly. Requires `uv` on PATH; we fail
  // fast at spawn-time with a clear error if it's missing (see
  // `planSubprocess`). The `-u` would only apply to a direct Python
  // invocation; `uv run` forwards stdout/stderr unbuffered by default.
  uv: { command: "uv", argsBefore: ["run"] },
  // `binary` is a no-op: exec the bundle entry directly.
  binary: { command: "", argsBefore: [] },
};

interface SubprocessPlan {
  command: string;
  args: string[];
  cwd: string;
}

function planSubprocess(spec: IntegrationSpawnSpec, bundleRoot: string): SubprocessPlan {
  const server = spec.manifest.server;
  if (!server) {
    throw new Error("integration-runtime-adapter-process: spec has no server to spawn");
  }
  const t = server.type;
  const cfg = HOST_INTERPRETER_BY_TYPE[t];
  if (!cfg) {
    throw new Error(
      `integration-runtime-adapter-process: server.type "${t}" has no host-interpreter mapping`,
    );
  }
  const entry = server.entry_point;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-process: server.entry_point required for server.type="${t}"`,
    );
  }
  const absEntry = resolveBundleEntry(bundleRoot, entry);
  if (t === "binary") {
    return { command: absEntry, args: [], cwd: bundleRoot };
  }
  return {
    command: cfg.command,
    args: [...cfg.argsBefore, absEntry],
    cwd: bundleRoot,
  };
}

/**
 * AFPS 2.0.2 §7.6 (CC-5) — materialise `delivery.files` for the process
 * adapter. Subprocesses share the host filesystem, so we attempt to write
 * each entry at the manifest-declared absolute path with the requested
 * mode. When that fails (typically a dev machine without write permission
 * to `/run/`, `/etc/`, …), we fall back to a per-run scratch dir under the
 * sidecar's tmp space and surface the actual path via an env var
 * `APPSTRATE_FILE_MOUNT_<sanitized-path>` so the integration code can pick
 * it up. Pure-Docker deployments don't hit the fallback (the runner image
 * always permits writes to `/tmp` and `/run/`).
 *
 * Returns the set of created paths so `shutdown()` can clean them up.
 */
/**
 * R8a — same safe-path floor as the docker adapter. Even though the process
 * adapter writes to the host filesystem (where the manifest path is far less
 * dangerous than inside a container), we still refuse kernel-managed surfaces
 * and the well-known privilege-escalation files to keep the contract uniform
 * across adapters and to prevent dev tooling from accidentally overwriting
 * host configs.
 */
export function isHostPathSafeForMount(hostPath: string): boolean {
  if (!hostPath.startsWith("/")) return false;
  const forbiddenPrefixes = ["/dev/", "/proc/", "/sys/"];
  for (const p of forbiddenPrefixes) {
    if (hostPath === p.replace(/\/$/, "") || hostPath.startsWith(p)) {
      return false;
    }
  }
  const forbiddenFiles = [
    "/etc/passwd",
    "/etc/passwd-",
    "/etc/shadow",
    "/etc/shadow-",
    "/etc/sudoers",
    "/etc/gshadow",
    "/etc/group",
    "/etc/group-",
  ];
  if (forbiddenFiles.includes(hostPath)) return false;
  if (hostPath.startsWith("/etc/sudoers.d/")) return false;
  return true;
}

export async function materializeFileMountsOnHost(
  runId: string,
  fileMounts: Record<string, { content_b64: string; mode: string }>,
): Promise<{ createdPaths: string[]; envOverrides: Record<string, string> }> {
  const createdPaths: string[] = [];
  const envOverrides: Record<string, string> = {};

  for (const [containerPath, entry] of Object.entries(fileMounts)) {
    // R8a — refuse kernel-managed / privilege-escalation surfaces even on
    // the process adapter. The fallback scratch path bypass is also gated
    // on this check: a manifest pointing at `/dev/null` would otherwise
    // silently write to the scratch dir, mojibake'ing the contract.
    if (!isHostPathSafeForMount(containerPath)) {
      logger.warn("delivery.files: refused to mount credential file at unsafe path; skipping", {
        manifestPath: containerPath,
      });
      continue;
    }
    const bytes = Buffer.from(entry.content_b64, "base64");
    const modeOctal = parseInt(entry.mode, 8);
    const finalMode = Number.isNaN(modeOctal) ? 0o400 : modeOctal;

    let writtenAt: string | null = null;
    try {
      // Try the manifest-declared path first. Best-effort `mkdir -p` for
      // the parent: deeper-than-existing paths get created if we have
      // permission, otherwise the writeFile catches and we fall back.
      const parent = dirname(containerPath);
      if (parent && parent !== "/" && parent !== ".") {
        await mkdir(parent, { recursive: true });
      }
      await writeFile(containerPath, bytes, { mode: finalMode });
      await chmod(containerPath, finalMode);
      writtenAt = containerPath;
    } catch (err) {
      // Fall back to a per-run scratch dir. Mirror the manifest path
      // structure so two files with the same basename don't collide.
      const scratchRoot = join(tmpdir(), `appstrate-mounts-${runId}`);
      const scratchPath = join(
        scratchRoot,
        containerPath.replace(/^\/+/, "").replace(/[^A-Za-z0-9._/-]+/g, "_"),
      );
      try {
        await mkdir(dirname(scratchPath), { recursive: true });
        await writeFile(scratchPath, bytes, { mode: finalMode });
        await chmod(scratchPath, finalMode);
        writtenAt = scratchPath;
        // Sanitise the manifest path into a valid env-var name fragment.
        const envSuffix = containerPath
          .replace(/^\/+/, "")
          .replace(/[^A-Za-z0-9]+/g, "_")
          .toUpperCase();
        envOverrides[`APPSTRATE_FILE_MOUNT_${envSuffix}`] = scratchPath;
        logger.info(
          "delivery.files: fell back to scratch path (process adapter could not write manifest path)",
          { manifestPath: containerPath, scratchPath, error: String(err) },
        );
      } catch (fallbackErr) {
        logger.warn("delivery.files: both manifest and scratch write failed; skipping entry", {
          manifestPath: containerPath,
          error: String(fallbackErr),
        });
      }
    }
    if (writtenAt) createdPaths.push(writtenAt);
  }

  return { createdPaths, envOverrides };
}

export function createProcessIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
  /**
   * Files/dirs created for `delivery.files` materialisation, cleaned up on
   * shutdown so per-run credential material doesn't outlive the run.
   */
  const createdPaths: string[] = [];

  return {
    id: "process",

    async prepare(runId: string): Promise<RuntimeAdapterRunContext> {
      logger.info("process integration adapter ready", { runId });
      // Subprocess inherits the parent's NS — loopback reaches the
      // listener directly.
      return {
        listenerBindHost: "127.0.0.1",
        proxyUrlFor: (port: number) => `http://127.0.0.1:${port}`,
      };
    },

    async spawn(options: SpawnIntegrationOptions): Promise<SpawnedIntegration> {
      const { runId, spec, bundleRoot, mitm, onStderrLine } = options;
      const plan = planSubprocess(spec, bundleRoot);
      const procEnv: Record<string, string> = { ...spec.spawnEnv };
      if (mitm) {
        // Subprocess sees the host fs directly; pass the CA path through
        // unchanged (no docker cp).
        Object.assign(procEnv, buildMitmEnvBlock(mitm.proxyUrl, mitm.caCertHostPath));
      }
      // AFPS 2.0.2 §7.6 (CC-5) — materialise `delivery.files` entries
      // before the subprocess starts so the entrypoint sees them at boot.
      if (spec.fileMounts && Object.keys(spec.fileMounts).length > 0) {
        const { createdPaths: paths, envOverrides } = await materializeFileMountsOnHost(
          runId,
          spec.fileMounts,
        );
        createdPaths.push(...paths);
        Object.assign(procEnv, envOverrides);
      }
      const transport = new SubprocessTransport({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: procEnv,
        envPassthrough: ["PATH", "HOME", "NODE_OPTIONS"],
        onStderrLine,
      });
      return { transport, diagnosticId: null };
    },

    async shutdown(): Promise<void> {
      // Nothing to do for the subprocess itself — SubprocessTransport owns it
      // and tears it down on `transport.close()` (called by the MCP client's
      // `client.close()` in `bootIntegrations.shutdown`).
      //
      // AFPS 2.0.2 §7.6 (CC-5) — clean up the per-run `delivery.files`
      // material so it doesn't outlive the run. Best-effort: a file already
      // gone (deleted by the integration, parent dir wiped, …) is fine.
      for (const path of createdPaths) {
        await rm(path, { force: true }).catch(() => {});
      }
      // Try to remove the per-run scratch dir if any was created.
      const scratchRoot = join(tmpdir(), `appstrate-mounts-`);
      // We can't enumerate the runId here without storing it; the per-path
      // unlinks above cover the actual files. The scratch dir itself is
      // empty after that and harmless if left behind.
      void scratchRoot;
      createdPaths.length = 0;
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "process",
  create: createProcessIntegrationRuntimeAdapter,
});
