// SPDX-License-Identifier: Apache-2.0

/**
 * Process adapter — the privilege-drop admission gate.
 *
 * A runner spawned by this adapter is a plain child of the sidecar on the
 * same uid, so it can read the sidecar's environment (platform API key,
 * run token, proxy credentials, every connected integration's decrypted
 * tokens) out of `/proc/<sidecar-pid>/environ` — the transport's env
 * allowlist bounds what we hand the child, not what the child can reach.
 * The only thing that closes it is landing the runner on a different uid,
 * which needs the `APPSTRATE_RUNNER_EXEC` wrapper the Firecracker guest
 * supervisor supplies and host process mode has no portable way to
 * provide.
 *
 * So the adapter refuses the spawn when the wrapper is absent. These
 * tests pin both halves: the refusal (and that it TELLS the operator what
 * to do), and that a supplied wrapper still spawns through the same argv
 * path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createProcessIntegrationRuntimeAdapter } from "../integration-runtime-adapter-process.ts";
import type { IntegrationSpawnSpec } from "../integrations-boot.ts";
import { installPassthroughRunnerExec } from "./helpers/runner-exec.ts";

function localSpec(): IntegrationSpawnSpec {
  return {
    integrationId: "@orga/third-party",
    namespace: "thirdparty",
    sourceKind: "local",
    manifest: {
      name: "@orga/third-party",
      version: "1.0.0",
      server: { type: "bun", entry_point: "server.ts", packageId: "@orga/third-party-mcp" },
    },
    spawnEnv: {},
  } as IntegrationSpawnSpec;
}

describe("process adapter — privilege-drop gate", () => {
  let bundleRoot: string;
  let previousRunnerExec: string | undefined;

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), "appstrate-privdrop-"));
    await writeFile(join(bundleRoot, "server.ts"), "process.exit(0);\n");
    previousRunnerExec = process.env.APPSTRATE_RUNNER_EXEC;
  });

  afterEach(async () => {
    if (previousRunnerExec === undefined) delete process.env.APPSTRATE_RUNNER_EXEC;
    else process.env.APPSTRATE_RUNNER_EXEC = previousRunnerExec;
    await rm(bundleRoot, { recursive: true, force: true });
  });

  it("refuses to spawn a local runner when no privilege-drop wrapper is configured", async () => {
    delete process.env.APPSTRATE_RUNNER_EXEC;
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-refuse");

    const spawn = adapter.spawn({
      runId: "run-refuse",
      spec: localSpec(),
      bundleRoot,
      egress: null,
      workspaceHandle: null,
      onStderrLine: () => {},
    });

    await expect(spawn).rejects.toThrow(/refusing to spawn/);
    // The message is the operator's only surface — it rides `failed[].error`
    // on the unauthenticated `GET /integrations/boot-report`. A refusal that
    // names nothing is the failure mode this repo keeps paying for, so pin
    // the parts that make it actionable: who was refused, why, what to do.
    // `.catch` widens to `Error | SpawnedIntegration`; the assertion above
    // already established this promise rejects, so narrow to the rejection.
    const error = (await spawn.catch((err: unknown) => err)) as Error;
    expect(error.message).toContain("@orga/third-party");
    expect(error.message).toContain("@orga/third-party-mcp");
    expect(error.message).toContain("APPSTRATE_RUNNER_EXEC");
    expect(error.message).toContain("RUN_ADAPTER=docker");
    expect(error.message).toContain("RUN_ADAPTER=firecracker");

    await adapter.shutdown();
  });

  it("refuses a wrapper that carries no setuid bit", async () => {
    // The gate was presence-only, so `APPSTRATE_RUNNER_EXEC=/usr/bin/env`
    // neutralised it silently and the sidecar handed its whole environ's
    // readability to third-party bytes while reporting a boundary. A file with
    // no setuid bit cannot change the child's uid whatever it does.
    const dir = await mkdtemp(join(tmpdir(), "appstrate-nosuid-"));
    const wrapper = join(dir, "runner-exec");
    await writeFile(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    process.env.APPSTRATE_RUNNER_EXEC = wrapper;
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-nosuid");
    try {
      const spawn = adapter.spawn({
        runId: "run-nosuid",
        spec: localSpec(),
        bundleRoot,
        egress: null,
        workspaceHandle: null,
        onStderrLine: () => {},
      });
      await expect(spawn).rejects.toThrow(/setuid/);
      const error = (await spawn.catch((err: unknown) => err)) as Error;
      // Actionable: names the file it rejected and the remedies, like the
      // absent-wrapper refusal does.
      expect(error.message).toContain(wrapper);
      expect(error.message).toContain("RUN_ADAPTER=docker");
    } finally {
      await adapter.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a wrapper that does not exist", async () => {
    process.env.APPSTRATE_RUNNER_EXEC = join(bundleRoot, "no-such-wrapper");
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-missing");
    try {
      await expect(
        adapter.spawn({
          runId: "run-missing",
          spec: localSpec(),
          bundleRoot,
          egress: null,
          workspaceHandle: null,
          onStderrLine: () => {},
        }),
      ).rejects.toThrow(/refusing to spawn/);
    } finally {
      await adapter.shutdown();
    }
  });

  it("spawns through the wrapper when the supervisor supplied one", async () => {
    const wrapper = await installPassthroughRunnerExec();
    const adapter = createProcessIntegrationRuntimeAdapter();
    await adapter.prepare("run-allow");

    // The runner dumps its argv + env and exits: proof the wrapper exec'd
    // the planned `<interpreter> <entry>` argv rather than swallowing it.
    const dump = join(bundleRoot, "argv.json");
    await writeFile(
      join(bundleRoot, "server.ts"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(dump)}, JSON.stringify({argv: process.argv, marker: process.env.MARKER})); process.exit(0);\n`,
    );

    try {
      const spawned = await adapter.spawn({
        runId: "run-allow",
        spec: { ...localSpec(), spawnEnv: { MARKER: "handed-over" } },
        bundleRoot,
        egress: null,
        workspaceHandle: null,
        onStderrLine: () => {},
      });
      // SubprocessTransport defers the actual spawn to `.start()` (normally
      // called by the MCP Client during `connect`).
      await spawned.transport.start();

      const deadline = Date.now() + 2_000;
      let parsed: { argv: string[]; marker?: string } | null = null;
      for (;;) {
        try {
          parsed = JSON.parse(await readFile(dump, "utf8")) as { argv: string[]; marker?: string };
          break;
        } catch {
          if (Date.now() > deadline) throw new Error("runner never flushed its argv dump");
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      // Compare on the bundle-relative tail: macOS resolves the tmpdir
      // through its `/private` symlink, so the absolute paths differ by
      // prefix even when they name the same file.
      expect(parsed.argv[1]).toEndWith(`${basename(bundleRoot)}/server.ts`);
      expect(parsed.marker).toBe("handed-over");

      await spawned.transport.close().catch(() => {});
      await adapter.shutdown();
    } finally {
      await wrapper.restore();
    }
  });
});
