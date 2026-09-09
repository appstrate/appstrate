// SPDX-License-Identifier: Apache-2.0

/**
 * The isolation gate's WALK, which no unit test reaches: a scan root narrowed by a plausible edit
 * reports the same tick over the files it stopped reading. `--verbose` lists what was read.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

async function runGate(args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "scripts/verify-module-isolation.ts", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

const verbose = await runGate(["--verbose"]);

describe("verify-module-isolation as a process", () => {
  it("passes over this repository", async () => {
    const { code, out, err } = await runGate();
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("module isolation clean");
  });

  it("reads a module's production code that lives outside `src/`", () => {
    expect(verbose.code).toBe(0);
    expect(verbose.out).toContain("scanned: packages/module-ee/drizzle/schema.ts");
  });

  it("reads `scripts/test`, the one platform root scanned with its tests", () => {
    // Drop `includeTests` for `scripts` and this line disappears while the summary stays "clean".
    expect(verbose.out).toContain("scanned: scripts/test/verify-module-isolation.test.ts");
  });

  it("keeps the two directions apart in its count line", () => {
    const counts = /— (\d+) files across (\d+) modules, (\d+) platform files/.exec(verbose.out);
    expect(counts).not.toBeNull();
    expect(Number(counts![1])).toBeGreaterThan(0);
    expect(Number(counts![2])).toBeGreaterThan(0);
    expect(Number(counts![3])).toBeGreaterThan(0);
  });
});
