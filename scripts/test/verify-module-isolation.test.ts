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

// Both spawns happen ONCE, here, and in parallel. The commercial-dependency
// direction reads every tracked source file in the repository, so a spawn
// inside an `it()` spends seconds of repo-wide I/O against that test's timeout
// — which is what it started failing on.
const [plain, verbose] = await Promise.all([runGate(), runGate(["--verbose"])]);

describe("verify-module-isolation as a process", () => {
  it("passes over this repository", () => {
    expect(plain.err).toBe("");
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("module isolation clean");
  });

  it("reads a module's production code that lives outside `src/`", () => {
    expect(verbose.code).toBe(0);
    expect(verbose.out).toContain("scanned: packages/module-ee/drizzle/schema.ts");
  });

  it("reads `scripts/test`, the one platform root scanned with its tests", () => {
    // Drop `includeTests` for `scripts` and this line disappears while the summary stays "clean".
    expect(verbose.out).toContain("scanned: scripts/test/verify-module-isolation.test.ts");
  });

  it("keeps the three directions apart in its count line", () => {
    const counts =
      /— (\d+) files across (\d+) modules, (\d+) platform files[^,]*, (\d+) tracked files/.exec(
        verbose.out,
      );
    expect(counts).not.toBeNull();
    expect(Number(counts![1])).toBeGreaterThan(0);
    expect(Number(counts![2])).toBeGreaterThan(0);
    expect(Number(counts![3])).toBeGreaterThan(0);
    // The commercial pass reads every tracked source file, so it is necessarily
    // the widest of the three — a narrowing edit shows up here as an inversion.
    expect(Number(counts![4])).toBeGreaterThan(Number(counts![3]));
  });

  it("reads the trees the other two directions skip — a test tree and the SPA", () => {
    // The blind spot #1373 named: `apps/api/test/**` sits under no platform
    // scan root at all, and `apps/web` is waived from the core→module rule, so
    // a static `@appstrate/module-ee` import in either passed every gate.
    expect(verbose.out).toContain(
      "scanned: apps/api/test/unit/module-isolation-acceptances.test.ts",
    );
    expect(verbose.out).toContain("scanned: apps/web/src/hooks/use-billing.ts");
  });

  it("names each file once, however many passes read it", () => {
    const scanned = [...verbose.out.matchAll(/^ {3}scanned: (.+)$/gm)].map((m) => m[1]!);
    expect(scanned.length).toBeGreaterThan(0);
    expect(new Set(scanned).size).toBe(scanned.length);
  });
});
