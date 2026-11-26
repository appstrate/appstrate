// SPDX-License-Identifier: Apache-2.0

/**
 * `server.type: "binary"` entry points are exec'd directly, but `extractBundle`
 * writes every file 0644: the boot path makes the entry (and only it) executable.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { rm, stat, symlink } from "node:fs/promises";
import { zipSync, type Zippable } from "fflate";
import { bootIntegrations, extractBundle } from "../integrations-boot.ts";
import { makeBundleEntryExecutable } from "../integration-runtime-adapter.ts";
import { noCallReporter } from "./helpers/call-journal.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";
import { installPassthroughRunnerExec } from "./helpers/runner-exec.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function extract(files: Zippable): Promise<string> {
  const root = await extractBundle(zipSync(files), "@scope/binary");
  roots.push(root);
  return root;
}

describe("makeBundleEntryExecutable", () => {
  it("makes only the entry executable, whatever mode the archive stores", async () => {
    const root = await extract({
      // Zip "made by Unix" attributes: a regular file with mode 0755.
      "bin/server": [enc("#!/bin/sh\n"), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
      "data.txt": enc("x"),
    });
    expect(await modeOf(path.join(root, "bin/server"))).toBe(0o644);

    await makeBundleEntryExecutable(root, "./bin/server");

    expect(await modeOf(path.join(root, "bin/server"))).toBe(0o755);
    expect(await modeOf(path.join(root, "data.txt"))).toBe(0o644);
  });

  it("refuses an entry that is not a regular file", async () => {
    const root = await extract({ "bin/server/inner": enc("x"), "real.sh": enc("#!/bin/sh\n") });
    await symlink(path.join(root, "real.sh"), path.join(root, "link"));
    for (const entry of ["./missing", "bin/server", ".", "./", "link"]) {
      await expect(makeBundleEntryExecutable(root, entry)).rejects.toThrow(
        `integration entryPoint "${entry}" is not a regular file in the bundle`,
      );
    }
    expect(await modeOf(path.join(root, "real.sh"))).toBe(0o644);
  });
});

// The bun-toolkit server as a self-executing script, booted by the process adapter.
const SCRIPT = `#!/usr/bin/env bun\n${readFileSync(path.join(import.meta.dir, "fixtures/bun-toolkit/server.ts"), "utf-8")}`;

async function withBoot(
  files: Zippable,
  fn: (boot: Awaited<ReturnType<typeof bootIntegrations>>) => Promise<void>,
): Promise<void> {
  const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
  const runnerExec = await installPassthroughRunnerExec();
  try {
    const boot = await bootIntegrations(
      [
        {
          integrationId: "@scope/binary",
          namespace: "binary",
          sourceKind: "local",
          manifest: {
            name: "@scope/binary",
            version: "1.0.0",
            server: { type: "binary", entry_point: "./bin/server" },
          },
          spawnEnv: {},
          toolAllowlist: ["system_info"],
        },
      ],
      {
        platformApiUrl: "http://platform.local",
        runToken: "run-tok-binary",
        callReporter: noCallReporter,
        fetchFn: (async () => new Response(zipSync(files))) as unknown as typeof fetch,
      },
    );
    await fn(boot).finally(() => boot.shutdown());
  } finally {
    await runnerExec.restore();
    if (prevAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = prevAdapter;
  }
}

describe("binary local integration — process adapter (e2e)", () => {
  it("spawns an entry stored 0644 and answers a tool call", () =>
    withBoot({ "bin/server": enc(SCRIPT) }, async (boot) => {
      expect(boot.failed).toEqual([]);
      const info = boot.tools.find((t) => t.descriptor.name === "binary__system_info")!;
      const res = await info.handler({}, {} as never);
      const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
      expect(JSON.parse(text)).toMatchObject({ runtime: "bun" });
    }));

  it("fails the integration in the boot report when the archive lacks the entry", () =>
    withBoot({ "bin/other": enc(SCRIPT) }, async (boot) => {
      expect(boot.report.ok).toBe(false);
      expect(boot.spawned).toEqual([]);
      expect(boot.failed.map((f) => f.error)).toEqual([
        expect.stringMatching(/not a regular file/),
      ]);
    }));
});
