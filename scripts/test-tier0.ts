// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * `bun run test:tier0` — the suite on PGlite, minus the modules that cannot run
 * there.
 *
 * The preload refuses to import, register or initialize a module whose
 * `test/requirements.ts` declares `{ postgres: true }` (see
 * `test/setup/modules.ts`). That decision has to reach bun's FILE COLLECTION
 * too, or the module's own tests still run — against a module that was never
 * loaded — and fail in a way that reads as a broken module rather than a tier
 * mismatch. Collection happens before the preload does anything, so the
 * exclusion cannot come from inside it; hence this wrapper.
 *
 * Why not `bunfig.toml`'s `pathIgnorePatterns`: it is static TOML, so the list
 * would be a hand-maintained roster of module directories that rots the day a
 * module changes its requirements — and it would apply to every tier, not just
 * this one. The list is derived here instead, from the same file the preload
 * reads.
 *
 * `--path-ignore-patterns` is passed once per pattern: bun treats the flag's
 * value as ONE glob, so a comma-joined list matches nothing (measured — the
 * comma form ran every file it was meant to exclude).
 *
 * Extra arguments are forwarded, so `bun run test:tier0 apps/api/test/unit`
 * works like a plain `bun test`. A bare `TEST_TIER=0 bun test` still works and
 * still skips the module at load time — only the file exclusion is this script's,
 * so run tier 0 through `bun run test:tier0` to get both halves.
 */

import { relative, resolve } from "node:path";
import { discoverModules, loadModuleRequirements, skipsInTier } from "../test/setup/modules.ts";

const ROOT = resolve(import.meta.dir, "..");

// `--path-ignore-patterns` REPLACES bunfig's `[test].pathIgnorePatterns` instead
// of adding to it, so the config's own list (the Playwright specs under
// `e2e/**`) has to be re-supplied here or bun collects them as bun tests.
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
