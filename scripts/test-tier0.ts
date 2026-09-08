// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

// `bun run test:tier0` — the suite on PGlite. Bun collects test files before the
// preload runs, so excluding a skipped module's tests needs this wrapper.

import { relative, resolve } from "node:path";
import { discoverModules, loadModuleRequirements, skipsInTier } from "../test/setup/modules.ts";

const ROOT = resolve(import.meta.dir, "..");

// The flag REPLACES bunfig's `[test].pathIgnorePatterns`, so that list is
// re-supplied here or bun collects the `e2e/**` Playwright specs as bun tests.
const bunfig = Bun.TOML.parse(await Bun.file(resolve(ROOT, "bunfig.toml")).text()) as {
  test?: { pathIgnorePatterns?: string[] };
};
const ignorePatterns: string[] = [...(bunfig.test?.pathIgnorePatterns ?? [])];
for (const { dir } of discoverModules(ROOT)) {
  const requirements = await loadModuleRequirements(dir);
  if (!skipsInTier(requirements, true)) continue;
  const rel = relative(ROOT, dir);
  ignorePatterns.push(`**/${rel}/**`);
  console.log(`tier0: excluding ${rel} from test collection — it requires a real PostgreSQL.`);
}

const child = Bun.spawnSync({
  cmd: [
    "bun",
    "test",
    // Once per pattern: bun reads the flag's value as ONE glob, so a
    // comma-joined list matches nothing (measured — it ran every excluded file).
    ...ignorePatterns.map((pattern) => `--path-ignore-patterns=${pattern}`),
    ...process.argv.slice(2),
  ],
  cwd: ROOT,
  env: { ...process.env, TEST_TIER: "0" },
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

process.exit(child.exitCode ?? 1);
