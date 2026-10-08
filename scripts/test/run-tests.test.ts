// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/run-tests.ts` decides which test files run where. A slip in it does
 * not fail a test — it silently drops one — so what it must guarantee is
 * asserted here: every file dealt exactly once, the same deal on every machine,
 * and the command line read the way `bun test` reads it.
 */

import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { collectFiles, deal, parseArgs } from "../run-tests.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("deal", () => {
  const files = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, "0")}.test.ts`);
  const weight = (file: string) => (Number(file.slice(1, 3)) % 7) + 1;

  it("hands every file to exactly one bin", () => {
    const bins = deal(files, 6, weight);
    expect(bins).toHaveLength(6);
    expect(bins.flat().sort()).toEqual([...files].sort());
  });

  it("deals the same bins whatever order the files arrive in", () => {
    expect(deal([...files].reverse(), 3, weight)).toEqual(deal(files, 3, weight));
  });

  it("balances the load within the heaviest single file", () => {
    const loads = deal(files, 4, weight).map((bin) => bin.reduce((sum, f) => sum + weight(f), 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(7);
  });
});

/**
 * Files no `scripts/run-tests.ts` job of `test.yml` runs, and the step that does:
 * `apps/cli` from its own workspace (the `unit` job's CLI step), the lint test in
 * `check.yml`.
 */
const RUN_ELSEWHERE = ["apps/cli/", "scripts/test/lint.test.ts"];

/** The `run-tests.ts` arguments a `test.yml` job passes, partition set to 1. */
async function workflowArgs(job: string): Promise<string[]> {
  const workflow = Bun.YAML.parse(
    await Bun.file(join(REPO_ROOT, ".github/workflows/test.yml")).text(),
  ) as { jobs: Record<string, { steps: { run?: string }[] }> };
  const runs = workflow.jobs[job]!.steps.map((step) => step.run ?? "");
  const invocations = runs.filter((run) => run.includes("scripts/run-tests.ts"));
  expect(invocations).toHaveLength(1);
  const joined = invocations[0]!.replaceAll("\\\n", " ");
  const command = joined.replaceAll("${{ matrix.partition }}", "1");
  // The shell strips the quotes around a glob (`--path-ignore-patterns='**/x/**'`).
  const words = command
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replaceAll("'", ""));
  const args = words.slice(words.indexOf("scripts/run-tests.ts") + 1);
  // A path filter is read against the working directory, which CI sets to the root.
  return args.map((arg) => (arg.startsWith("-") ? arg : join(REPO_ROOT, arg)));
}

describe("the CI jobs over the real file list", () => {
  it("run every collected test file exactly once between them", async () => {
    const all = await collectFiles(parseArgs([]));
    expect(all.length).toBeGreaterThan(100);
    const unit = new Set(await collectFiles(parseArgs(await workflowArgs("unit"))));
    const integration = new Set(await collectFiles(parseArgs(await workflowArgs("integration"))));
    expect(unit.size).toBeGreaterThan(0);
    expect(integration.size).toBeGreaterThan(0);

    const unrun: string[] = [];
    const twice: string[] = [];
    for (const file of all) {
      const runs = [
        unit.has(file),
        integration.has(file),
        RUN_ELSEWHERE.some((path) => file.startsWith(path)),
      ].filter(Boolean).length;
      if (runs === 0) unrun.push(file);
      if (runs > 1) twice.push(file);
    }
    expect(unrun).toEqual([]);
    expect(twice).toEqual([]);
    expect([...unit, ...integration].filter((file) => !all.includes(file))).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("separates its own flags, path filters and the flags it hands to bun test", () => {
    const options = parseArgs([
      "apps/api/test",
      "--shards",
      "4",
      "--partition=2/3",
      "--path-ignore-patterns=**/fixtures/**",
      "-t",
      "some name",
      "--coverage",
    ]);
    expect(options.filters).toEqual(["apps/api/test"]);
    expect(options.shards).toBe(4);
    expect(options.partition).toEqual({ index: 2, count: 3 });
    expect(options.ignores).toEqual(["**/fixtures/**"]);
    expect(options.forwarded).toEqual(["-t", "some name", "--coverage"]);
  });

  it("keeps a filter's trailing slash, which narrows it to a directory", () => {
    expect(parseArgs(["test/integration/"]).filters).toEqual(["test/integration/"]);
    expect(parseArgs(["test/integration"]).filters).toEqual(["test/integration"]);
  });

  it("refuses a partition outside 1..K", () => {
    expect(() => parseArgs(["--partition=4/3"])).toThrow();
    expect(() => parseArgs(["--partition=0/3"])).toThrow();
  });
});
