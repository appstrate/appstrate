// SPDX-License-Identifier: Apache-2.0

/**
 * The two roster invariants of `scripts/verify-module-contract.ts`.
 *
 * Both failures are silent in the direction that matters. An owner that is not
 * a `DECLARER_ROOTS` key is never scanned, so every drift check on its entry
 * becomes a no-op while the entry still counts towards the ">= 2 owners" rule;
 * a module in one roster and not the other is scanned but unclassified, or
 * classified but unscanned. Neither shows up in the success line.
 *
 * The script has no importable seam — it runs its scan at module load and exits
 * — so these drive it as a process, mutating the tracked source and restoring
 * it in a `finally`. Do not run this suite in parallel with anything else that
 * reads `scripts/verify-module-contract.ts`.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GATE = join(REPO_ROOT, "scripts", "verify-module-contract.ts");

function runGateWith(mutate: (source: string) => string): { code: number; output: string } {
  const original = readFileSync(GATE, "utf8");
  const mutated = mutate(original);
  if (mutated === original) {
    throw new Error("the mutation matched nothing — verify-module-contract.ts was restructured.");
  }
  try {
    writeFileSync(GATE, mutated);
    const run = Bun.spawnSync({
      cmd: ["bun", "scripts/verify-module-contract.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: run.exitCode ?? 1, output: run.stdout.toString() + run.stderr.toString() };
  } finally {
    writeFileSync(GATE, original);
  }
}

describe("scripts/verify-module-contract.ts as a process", () => {
  it("passes on the tree as it stands", () => {
    // The positive control: without it, a gate that failed on everything would
    // make both assertions below pass for the wrong reason.
    const run = Bun.spawnSync({
      cmd: ["bun", "scripts/verify-module-contract.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.stdout.toString()).toContain("module contract clean");
    expect(run.exitCode).toBe(0);
  }, 60_000);

  it("fails on a ledger owner that is not a known module", () => {
    const { code, output } = runGateWith((source) =>
      source.replace(
        'beforeUsage: { owners: ["module-ee"] }',
        'beforeUsage: { owners: ["cloud"] }',
      ),
    );
    expect(code).not.toBe(0);
    expect(output).toContain("unknown owner: HOOK_LEDGER.beforeUsage.owners names `cloud`");
  }, 60_000);

  it("fails when MODULE_TENANT and DECLARER_ROOTS name different modules", () => {
    const { code, output } = runGateWith((source) => source.replace('  "module-ee": "ee",\n', ""));
    expect(code).not.toBe(0);
    expect(output).toContain("MODULE_TENANT and DECLARER_ROOTS name different modules");
  }, 60_000);
});
