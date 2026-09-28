// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "../launcher.ts");
const SECRET = "launcher-test-dummy-sink-secret";

describe("runtime launcher", () => {
  let dir: string;
  let entry: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "launcher-test-"));
    entry = join(dir, "entry.ts");
    // Reports its env, its stdin, and what a child spawned WITHOUT an explicit
    // env inherits (the startup snapshot), then exits with $EXIT_CODE.
    writeFileSync(
      entry,
      `const stdin = await Bun.stdin.text();
       const child = Bun.spawnSync(["sh", "-c", "echo \${APPSTRATE_SINK_SECRET:-none}"]);
       console.log(JSON.stringify({ env: process.env, stdin, child: child.stdout.toString().trim() }));
       if (process.env.HANG) { process.on("SIGTERM", () => process.exit(42)); await Bun.sleep(60_000); }
       process.exit(Number(process.env.EXIT_CODE ?? 0));`,
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function launch(extraEnv: Record<string, string>) {
    return Bun.spawn(["bun", LAUNCHER, entry], {
      env: {
        PATH: process.env.PATH!,
        APPSTRATE_SINK_SECRET: SECRET,
        AGENT_RUN_ID: "run_1",
        ...extraEnv,
      },
      stdout: "pipe",
    });
  }

  it("hands the secrets over on stdin, never in the entrypoint's environment", async () => {
    const proc = launch({ EXIT_CODE: "7" });
    const report = JSON.parse(await new Response(proc.stdout).text());

    expect(await proc.exited).toBe(7);
    expect(report.env.AGENT_RUN_ID).toBe("run_1");
    expect(report.env.APPSTRATE_SINK_SECRET).toBeUndefined();
    expect(report.child).toBe("none");
    expect(JSON.parse(report.stdin)).toEqual({ APPSTRATE_SINK_SECRET: SECRET });
  });

  it("forwards SIGTERM to the entrypoint and exits with its status", async () => {
    const proc = launch({ HANG: "1" });
    const reader = proc.stdout.getReader();
    await reader.read(); // the report line: the entrypoint is up and waiting
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(42);
  });
});
