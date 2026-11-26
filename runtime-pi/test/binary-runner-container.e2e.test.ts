// SPDX-License-Identifier: Apache-2.0

/**
 * Container e2e — a `server.type: "binary"` integration boots in the real
 * `appstrate-mcp-runner-binary` image through `bootIntegrations` and the docker
 * adapter. The entry is the bun-toolkit fixture compiled for the engine's
 * linux/musl arch, extracted 0644: the runner (uid 1001) can exec it only
 * because the sidecar marks it executable.
 *
 * Gated like the other container e2e suites (`TEST_DOCKER=1` locally, always in CI).
 *   docker build -t appstrate-mcp-runner-binary:latest runtime-pi/runners/binary
 */

import { $ } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipArtifact } from "@appstrate/core/zip";
import { bootIntegrations } from "../sidecar/integrations-boot.ts";
import { noCallReporter } from "../sidecar/test/helpers/call-journal.ts";
import { docker, resolveContainerE2eGate } from "./helpers/container-e2e.ts";

const IMAGE = process.env.RUNNER_IMAGE_BINARY ?? "appstrate-mcp-runner-binary:latest";
const { run: RUN, daemon } = resolveContainerE2eGate("binary-runner-container.e2e", [IMAGE]);
const BUN_ARCH: Record<string, string> = { "linux/amd64": "x64", "linux/arm64": "arm64" };

describe.skipIf(!RUN)("binary local integration in the real runner image", () => {
  const runId = `run_binary_e2e_${Date.now()}`;
  // The platform creates this network per run; the docker adapter joins it.
  const network = `appstrate-exec-${runId}`;
  const runners = () => docker(["ps", "-aq", "--filter", `label=appstrate.run=${runId}`]).stdout;
  let workDir: string | undefined;

  afterAll(async () => {
    const leaked = runners().trim();
    if (leaked) docker(["rm", "-f", ...leaked.split("\n")]);
    docker(["network", "rm", network]);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("spawns a 0644-bundled native entry and answers a tool call", async () => {
    workDir = await mkdtemp(join(tmpdir(), "binary-runner-e2e-"));
    const outfile = join(workDir, "server");
    const source = join(import.meta.dir, "../sidecar/test/fixtures/bun-toolkit/server.ts");
    const target = `bun-linux-${BUN_ARCH[daemon ?? ""]}-musl`;
    await $`${process.execPath} build --compile --target=${target} ${source} --outfile ${outfile}`.quiet();
    // Stored uncompressed: deflating the ~75 MB binary costs seconds and tests nothing.
    const bundle = zipArtifact({ "bin/server": await Bun.file(outfile).bytes() }, 0);
    expect(docker(["network", "create", network]).status).toBe(0);

    const env = { RUN_ID: runId, INTEGRATION_RUNTIME_ADAPTER: "docker" };
    const prevEnv = Object.entries(env).map(([k]) => [k, process.env[k]] as const);
    Object.assign(process.env, env);
    let boot: Awaited<ReturnType<typeof bootIntegrations>> | undefined;
    try {
      boot = await bootIntegrations(
        [
          {
            integrationId: "@e2e/binary",
            namespace: "binary",
            sourceKind: "local",
            manifest: {
              name: "@e2e/binary",
              version: "1.0.0",
              server: { type: "binary", entry_point: "./bin/server" },
            },
            spawnEnv: {},
            toolAllowlist: ["system_info"],
          },
        ],
        {
          runId,
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-binary-e2e",
          callReporter: noCallReporter,
          fetchFn: (async () => new Response(bundle)) as unknown as typeof fetch,
        },
      );
      expect(boot.failed, JSON.stringify(boot.report)).toEqual([]);
      expect(boot.report.adapter).toBe("docker");
      const info = boot.tools.find((t) => t.descriptor.name === "binary__system_info")!;
      const res = await info.handler({}, {} as never);
      const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
      expect(JSON.parse(text)).toMatchObject({ runtime: "bun", platform: "linux" });
    } finally {
      await boot?.shutdown();
      for (const [k, v] of prevEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // Shutdown removes every runner container of the run.
    expect(runners().trim()).toBe("");
  }, 180_000);
});
