// SPDX-License-Identifier: Apache-2.0

/**
 * The isolation gate over this repository, and the two scan roots that decide
 * what it can see.
 *
 * The pure review functions are covered by
 * `apps/api/test/unit/module-isolation-acceptances.test.ts`; what no unit test
 * can reach is the WALK. A scan root is the gate's whole field of view, and one
 * narrowed by a plausible-looking edit reports the same cheerful tick over the
 * files it stopped reading:
 *
 *   - a module's root is its PACKAGE, not its `src/` — `packages/module-ee`
 *     keeps production code in `drizzle/`, and the platform walk skips
 *     `module-*`, so pinning the root at `src/` puts those files in no scan at
 *     all;
 *   - `scripts/` is the one platform root scanned WITH its tests — they are
 *     Apache-2.0 code running in CI on the platform's behalf, and a static
 *     module import there drags a differently-licensed package in exactly as a
 *     non-test one would.
 *
 * `--verbose` lists what was read, so both are assertable.
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
    // Narrow the module root back to `src/` and this line disappears while the
    // summary still says "clean".
    expect(verbose.out).toContain("scanned: packages/module-ee/drizzle/schema.ts");
  });

  it("reads `scripts/test`, the one platform root scanned with its tests", () => {
    // Drop `includeTests` for `scripts` and this line disappears, taking with
    // it the only thing that would catch a static module import written there.
    expect(verbose.out).toContain("scanned: scripts/test/verify-module-isolation.test.ts");
  });

  it("keeps the two directions apart in its count line", () => {
    // The listing above proves WHICH files; the summary is what a reader sees,
    // and a zero on either side is a scan that read nothing.
    const counts = /— (\d+) files across (\d+) modules, (\d+) platform files/.exec(verbose.out);
    expect(counts).not.toBeNull();
    expect(Number(counts![1])).toBeGreaterThan(0);
    expect(Number(counts![2])).toBeGreaterThan(0);
    expect(Number(counts![3])).toBeGreaterThan(0);
  });
});
