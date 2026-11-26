// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — a `server.type: "binary"` local integration spawns and
 * completes the MCP handshake in the real `appstrate-mcp-runner-binary` image
 * (#2383).
 *
 * The entry is a real native executable (a tiny MCP stdio server compiled with
 * `bun build --compile` for the engine's linux/musl arch) stored 0644 in the
 * bundle zip, then booted through the sidecar's real `bootIntegrations` path:
 * extraction, entry chmod, docker adapter, runner image. `docker cp` keeps the
 * archive's 0644, so the runner (uid 1001) can exec the entry only because the
 * sidecar marks it executable.
 *
 * Gated like the other container e2e suites: opt-in locally (`TEST_DOCKER=1`),
 * always on in CI, skipped when Docker or a native-platform image is absent.
 * Build the image natively:
 *   docker build -t appstrate-mcp-runner-binary:latest runtime-pi/runners/binary
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipArtifact } from "@appstrate/core/zip";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations } from "../sidecar/integrations-boot.ts";
import { docker, resolveContainerE2eGate } from "./helpers/container-e2e.ts";

const IMAGE = process.env.RUNNER_IMAGE_BINARY ?? "appstrate-mcp-runner-binary:latest";
const DEADLINE_MS = 180_000;

const { run: RUN, daemon } = resolveContainerE2eGate("binary-runner-container.e2e", [IMAGE]);

const INTEG_ID = "@e2e/binary-probe";
const NAMESPACE = "binaryprobe";
const ENTRY = "bin/probe";

/** Docker platform → `bun build --compile` musl target. */
const BUN_TARGET_BY_PLATFORM: Record<string, string> = {
  "linux/amd64": "bun-linux-x64-musl",
  "linux/arm64": "bun-linux-arm64-musl",
};

/**
 * Compile a one-tool MCP stdio server into a native executable. The SDK is a
 * sidecar dependency, so its modules are imported by the absolute path they
 * resolve to from there.
 */
async function compileProbeServer(dir: string, target: string): Promise<Uint8Array> {
  const sidecarDir = join(import.meta.dir, "../sidecar");
  const sdk = (path: string) =>
    JSON.stringify(Bun.resolveSync(`@modelcontextprotocol/sdk/${path}`, sidecarDir));
  const source = join(dir, "server.ts");
  await Bun.write(
    source,
    [
      `import { McpServer } from ${sdk("server/mcp.js")};`,
      `import { StdioServerTransport } from ${sdk("server/stdio.js")};`,
      `const server = new McpServer({ name: "binary-probe", version: "1.0.0" });`,
      `server.registerTool("ping", { description: "Answers pong." }, async () => ({`,
      `  content: [{ type: "text", text: "pong" }],`,
      `}));`,
      `await server.connect(new StdioServerTransport());`,
    ].join("\n"),
  );
  const outfile = join(dir, "probe");
  const build = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    `--target=${target}`,
    source,
    "--outfile",
    outfile,
  ]);
  expect(build.exitCode, `bun build --compile failed: ${build.stderr.toString()}`).toBe(0);
  return new Uint8Array(await Bun.file(outfile).arrayBuffer());
}

/**
 * The integration archive, the entry a plain 0644 file. Stored uncompressed:
 * deflating ~75 MB costs seconds on each side and tests nothing.
 */
function bundleBytes(binary: Uint8Array): Uint8Array {
  return zipArtifact({ [ENTRY]: [binary, { os: 3, attrs: 0o100644 << 16 }] }, 0);
}

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEG_ID,
    namespace: NAMESPACE,
    sourceKind: "local",
    manifest: {
      name: INTEG_ID,
      version: "1.0.0",
      server: { type: "binary", entry_point: `./${ENTRY}` },
    },
    spawnEnv: {},
    toolAllowlist: ["ping"],
  };
}

/** Serves the bundle on the platform's integration-bundle route, 404 elsewhere. */
function platformFetch(bundle: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/integration-bundle/")) return new Response(bundle);
    return Response.json({ detail: `unexpected platform call: ${url}` }, { status: 404 });
  }) as unknown as typeof fetch;
}

/** Set env vars, returning a function that restores their previous values. */
function setEnv(vars: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe.skipIf(!RUN)("binary local integration in the real runner image", () => {
  const runId = `run_binary_e2e_${Date.now()}`;
  // The platform creates this network per run; the docker adapter joins it.
  const network = `appstrate-exec-${runId}`;
  let workDir: string | undefined;

  afterAll(async () => {
    const leaked = docker(["ps", "-aq", "--filter", `label=appstrate.run=${runId}`]).stdout.trim();
    if (leaked) docker(["rm", "-f", ...leaked.split("\n")]);
    docker(["network", "rm", network]);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it(
    "spawns a 0644-bundled native entry, completes the handshake and lists its tool",
    async () => {
      const target = BUN_TARGET_BY_PLATFORM[daemon ?? ""];
      if (!target) throw new Error(`no bun --compile target for docker platform ${daemon}`);
      workDir = await mkdtemp(join(tmpdir(), "binary-runner-e2e-"));
      const bundle = bundleBytes(await compileProbeServer(workDir, target));

      const net = docker(["network", "create", network]);
      expect(net.status, `docker network create failed: ${net.stderr}`).toBe(0);

      const restoreEnv = setEnv({ RUN_ID: runId, INTEGRATION_RUNTIME_ADAPTER: "docker" });
      let boot: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
      try {
        boot = await bootIntegrations([spec()], {
          runId,
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-binary-e2e",
          fetchFn: platformFetch(bundle),
        });

        expect(boot.failed, JSON.stringify(boot.report)).toEqual([]);
        expect(boot.spawned.length).toBe(1);
        expect(boot.report.adapter).toBe("docker");

        const ping = boot.tools.find((t) => t.descriptor.name === `${NAMESPACE}__ping`);
        expect(ping, boot.tools.map((t) => t.descriptor.name).join(", ")).toBeDefined();
        const res = await ping!.handler({}, {} as never);
        expect((res.content?.[0] as { text?: string } | undefined)?.text).toBe("pong");
      } finally {
        if (boot) await boot.shutdown();
        restoreEnv();
      }

      // Shutdown removes every runner container of the run.
      const left = docker(["ps", "-aq", "--filter", `label=appstrate.run=${runId}`]);
      expect(left.stdout.trim()).toBe("");
    },
    DEADLINE_MS,
  );
});
