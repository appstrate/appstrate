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

import { normalize, join, posix } from "node:path";

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
  const entry = server.entryPoint;
  if (!entry) {
    throw new Error(
      `integration-runtime-adapter-process: server.entryPoint required for server.type="${t}"`,
    );
  }
  const absEntry = normalize(join(bundleRoot, entry));
  if (!absEntry.startsWith(bundleRoot + posix.sep) && absEntry !== bundleRoot) {
    throw new Error(`integration-runtime-adapter-process: server.entryPoint escapes bundle root`);
  }
  if (t === "binary") {
    return { command: absEntry, args: [], cwd: bundleRoot };
  }
  return {
    command: cfg.command,
    args: [...cfg.argsBefore, absEntry],
    cwd: bundleRoot,
  };
}

export function createProcessIntegrationRuntimeAdapter(): IntegrationRuntimeAdapter {
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
      const { spec, bundleRoot, mitm, onStderrLine } = options;
      const plan = planSubprocess(spec, bundleRoot);
      const procEnv: Record<string, string> = { ...spec.spawnEnv };
      if (mitm) {
        // Subprocess sees the host fs directly; pass the CA path through
        // unchanged (no docker cp).
        Object.assign(procEnv, buildMitmEnvBlock(mitm.proxyUrl, mitm.caCertHostPath));
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
      // Nothing to do — SubprocessTransport owns the subprocess and
      // tears it down on `transport.close()` (called by the MCP
      // client's `client.close()` in `bootIntegrations.shutdown`).
    },
  };
}

registerIntegrationRuntimeAdapter({
  id: "process",
  create: createProcessIntegrationRuntimeAdapter,
});
