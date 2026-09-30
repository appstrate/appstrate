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

describe("--partition over the real file list", () => {
  it("covers every collected test file exactly once across the CI slices", async () => {
    const files = await collectFiles(parseArgs([]));
    expect(files.length).toBeGreaterThan(100);
    const size = (file: string) => Bun.file(join(REPO_ROOT, file)).size;
    const slices = deal(files, 3, size);
    expect(slices.every((slice) => slice.length > 0)).toBe(true);
    expect(slices.flat().sort()).toEqual(files);
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

  it("refuses a partition outside 1..K", () => {
    expect(() => parseArgs(["--partition=4/3"])).toThrow();
    expect(() => parseArgs(["--partition=0/3"])).toThrow();
  });
});
