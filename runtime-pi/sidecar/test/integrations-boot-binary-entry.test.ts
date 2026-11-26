// SPDX-License-Identifier: Apache-2.0

/**
 * `server.type: "binary"` entry points are exec'd directly, but
 * `extractBundle` writes every archive file `0644`. The boot path makes the
 * resolved entry (and only it) executable before the adapter spawns it.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { zipSync, type Zippable } from "fflate";
import type { IntegrationSpawnSpec } from "@appstrate/core/sidecar-types";
import { bootIntegrations, extractBundle } from "../integrations-boot.ts";
import { makeBundleEntryExecutable } from "../integration-runtime-adapter.ts";
import { HERMETIC_PROCESS_ADAPTER_ID } from "./helpers/hermetic-process-adapter.ts";
import { installPassthroughRunnerExec } from "./helpers/runner-exec.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
/** Unix external attributes for a regular file with `mode` (zip "made by" Unix). */
const unixAttrs = (mode: number) => ({ os: 3, attrs: ((0o100000 | mode) << 16) >>> 0 });

const roots: string[] = [];
async function extract(files: Zippable): Promise<string> {
  const root = await extractBundle(zipSync(files), "@scope/binary");
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("makeBundleEntryExecutable", () => {
  for (const [label, entry] of [
    ["no archive mode", enc("#!/bin/sh\n")],
    ["archive mode 0644", [enc("#!/bin/sh\n"), unixAttrs(0o644)]],
    ["archive mode 0755", [enc("#!/bin/sh\n"), unixAttrs(0o755)]],
  ] as const) {
    it(`makes the extracted entry 0755 (${label}) and leaves other files 0644`, async () => {
      const root = await extract({ "bin/server": entry as Zippable[string], "data.txt": enc("x") });
      expect(await modeOf(path.join(root, "bin/server"))).toBe(0o644);

      await makeBundleEntryExecutable(root, "./bin/server");

      expect(await modeOf(path.join(root, "bin/server"))).toBe(0o755);
      expect(await modeOf(path.join(root, "data.txt"))).toBe(0o644);
    });
  }

  it("refuses a missing entry", async () => {
    const root = await extract({ "data.txt": enc("x") });
    await expect(makeBundleEntryExecutable(root, "./bin/server")).rejects.toThrow(
      'integration entryPoint "./bin/server" is not a regular file in the bundle',
    );
  });

  it("refuses a directory", async () => {
    const root = await extract({ "bin/server/inner": enc("x") });
    await expect(makeBundleEntryExecutable(root, "bin/server")).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("refuses the bundle root itself", async () => {
    const root = await extract({ "data.txt": enc("x") });
    for (const entry of [".", "./"]) {
      await expect(makeBundleEntryExecutable(root, entry)).rejects.toThrow(/not a regular file/);
    }
  });

  it("refuses a symlink", async () => {
    const root = await extract({ "real.sh": enc("#!/bin/sh\n") });
    await symlink(path.join(root, "real.sh"), path.join(root, "link"));
    await expect(makeBundleEntryExecutable(root, "link")).rejects.toThrow(/not a regular file/);
    expect(await modeOf(path.join(root, "real.sh"))).toBe(0o644);
  });

  it("refuses a traversal entry without touching the outside file", async () => {
    const root = await extract({ "data.txt": enc("x") });
    const outside = `${root}-outside`;
    roots.push(outside);
    await mkdir(outside);
    await writeFile(path.join(outside, "victim"), "x", { mode: 0o644 });
    const escape = `../${path.basename(outside)}/victim`;
    await expect(makeBundleEntryExecutable(root, escape)).rejects.toThrow(/escapes bundle root/);
    expect(await modeOf(path.join(outside, "victim"))).toBe(0o644);
  });
});

// ─── end to end: the real boot path with the process adapter ───

const TOOLKIT_SERVER = path.join(import.meta.dir, "fixtures/bun-toolkit/server.ts");
const INTEG_ID = "@appstrate/binary-toolkit";
const NAMESPACE = "binarytoolkit";

function spec(): IntegrationSpawnSpec {
  return {
    integrationId: INTEG_ID,
    namespace: NAMESPACE,
    sourceKind: "local",
    manifest: {
      name: INTEG_ID,
      version: "1.0.0",
      server: { type: "binary", entry_point: "./bin/server" },
    },
    spawnEnv: {},
    toolAllowlist: ["uuid", "system_info"],
  };
}

/** The bun-toolkit server as a self-executing script, stored 0644 in the archive at `entry`. */
function bundleBytes(entry = "bin/server"): Uint8Array {
  const script = `#!/usr/bin/env bun\n${readFileSync(TOOLKIT_SERVER, "utf-8")}`;
  return zipSync({ [entry]: [enc(script), unixAttrs(0o644)] });
}

function platformFetch(bundle = bundleBytes()): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/internal/integration-bundle/")) return new Response(bundle);
    return new Response(JSON.stringify({ detail: `unexpected platform call: ${url}` }), {
      status: 404,
    });
  }) as unknown as typeof fetch;
}

async function withProcessAdapter(fn: () => Promise<void>): Promise<void> {
  const prevAdapter = process.env.INTEGRATION_RUNTIME_ADAPTER;
  process.env.INTEGRATION_RUNTIME_ADAPTER = HERMETIC_PROCESS_ADAPTER_ID;
  const runnerExec = await installPassthroughRunnerExec();
  try {
    await fn();
  } finally {
    await runnerExec.restore();
    if (prevAdapter === undefined) delete process.env.INTEGRATION_RUNTIME_ADAPTER;
    else process.env.INTEGRATION_RUNTIME_ADAPTER = prevAdapter;
  }
}

describe("binary local integration — process adapter (e2e)", () => {
  it(
    "spawns an entry stored 0644, completes the MCP handshake and lists its tools",
    () =>
      withProcessAdapter(async () => {
        let boot: Awaited<ReturnType<typeof bootIntegrations>> | null = null;
        try {
          boot = await bootIntegrations([spec()], {
            platformApiUrl: "http://platform.local",
            runToken: "run-tok-binary",
            fetchFn: platformFetch(),
          });

          expect(boot.failed).toEqual([]);
          expect(boot.spawned.length).toBe(1);
          expect(boot.report.ok).toBe(true);

          const names = boot.tools
            .map((t) => t.descriptor.name)
            .filter((n) => n.startsWith(NAMESPACE));
          expect(names.sort()).toEqual([`${NAMESPACE}__system_info`, `${NAMESPACE}__uuid`]);

          const info = boot.tools.find((t) => t.descriptor.name === `${NAMESPACE}__system_info`)!;
          const res = await info.handler({}, {} as never);
          const text = (res.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
          expect(JSON.parse(text)).toMatchObject({ runtime: "bun" });
        } finally {
          if (boot) await boot.shutdown();
        }
      }),
    30_000,
  );

  it(
    "fails the integration in the boot report when the archive lacks the entry",
    () =>
      withProcessAdapter(async () => {
        const boot = await bootIntegrations([spec()], {
          platformApiUrl: "http://platform.local",
          runToken: "run-tok-binary",
          fetchFn: platformFetch(bundleBytes("bin/other")),
        });
        try {
          expect(boot.report.ok).toBe(false);
          expect(boot.spawned).toEqual([]);
          expect(boot.failed).toHaveLength(1);
          expect(boot.failed[0]!.integrationId).toBe(INTEG_ID);
          expect(boot.failed[0]!.error).toMatch(/not a regular file/);
        } finally {
          await boot.shutdown();
        }
      }),
    30_000,
  );
});
