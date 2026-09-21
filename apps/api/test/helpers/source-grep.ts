// SPDX-License-Identifier: Apache-2.0

/**
 * Searching the SOURCE TREE from a test.
 *
 * A conformance guard that searches the tree is only worth the line it occupies
 * while the search actually reaches the tree. Two things used to break that, and
 * both produced the SAME shape — an empty result, which is also the shape of
 * "nothing violates the rule", so the guard passed while guarding nothing.
 *
 * 1. `Bun.spawnSync(["grep", …])` inherits `process.cwd()`, so RELATIVE roots
 *    read as "no file names it" from anywhere else.
 *
 * 2. Spawning at all. A `bun test` run over the whole repository holds ~10,600
 *    file descriptors by the end — almost all of them DIRECTORY handles under
 *    `node_modules/.bun`, held by Bun's module resolver and proportional to the
 *    number of modules loaded, not to anything this repository does. Past that
 *    point `posix_spawn` fails, and the failure is mute: exit 2, no signal, no
 *    stdout, and an EMPTY stderr, because no process was ever created. Measured
 *    on three consecutive full runs from a clean database, always at the same
 *    three call sites, never in isolation. It is not a flake and it is not a
 *    descriptor leak in the platform — the API loads its modules once.
 *
 * So this searches IN-PROCESS. No child, no cwd, nothing to exhaust: it reads
 * the files the roots contain and asks whether the text is in them. `expectMatch`
 * is the positive control on top — a needle that must still match a known file,
 * so a rename cannot read as compliance.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** The monorepo root, resolved from this file — never from `process.cwd()`. */
export const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** Directories a source search never descends into. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

/** Absolute paths of every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...filesUnder(join(dir, entry.name)));
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Files under `roots` (repo-relative directories) whose text contains `needle`,
 * as SORTED repo-relative paths. `needle` is matched LITERALLY, never as a
 * pattern — the callers search for source fragments like `eq(table.packageId`.
 *
 * @throws when a root does not exist, or when `expectMatch` names a file the
 * search did not return — either says the search is no longer asking the
 * question the caller thinks it is.
 */
export function grepFiles(
  needle: string,
  roots: string[],
  options: { expectMatch?: string[] } = {},
): string[] {
  const files: string[] = [];

  for (const root of roots) {
    const absoluteRoot = resolve(REPO_ROOT, root);
    // A missing root is the silent-empty-result failure in another costume.
    if (!statSync(absoluteRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`source-grep: ${absoluteRoot} is not a directory — nothing was searched`);
    }
    for (const file of filesUnder(absoluteRoot)) {
      // A binary file decodes to replacement characters rather than throwing,
      // and cannot contain the ASCII source fragments these guards look for.
      if (readFileSync(file, "utf8").includes(needle)) {
        files.push(relative(REPO_ROOT, file));
      }
    }
  }

  files.sort();

  for (const expected of options.expectMatch ?? []) {
    if (!files.includes(expected)) {
      throw new Error(
        `positive control failed: ${JSON.stringify(needle)} no longer matches ${expected}. ` +
          `The guard built on it would pass without asking anything. Found: ${files.join(", ") || "(nothing)"}`,
      );
    }
  }

  return files;
}
