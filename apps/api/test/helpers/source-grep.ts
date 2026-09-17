// SPDX-License-Identifier: Apache-2.0

/**
 * Searching the SOURCE TREE from a test, without depending on the ambient cwd.
 *
 * A conformance guard that greps the tree is only worth the line it occupies
 * while the grep actually reaches the tree. `Bun.spawnSync(["grep", …])`
 * inherits `process.cwd()`, and the root suite does not own it: two CLI tests
 * (`apps/cli/test/install/project.test.ts`, `packages/afps-runtime/test/cli/bundle.test.ts`)
 * `process.chdir()` into a temporary directory for the length of a case. A guard
 * whose roots are RELATIVE therefore reads an empty result whenever it runs
 * while the cwd is somewhere else — and an empty result is the shape of
 * "nothing violates the rule", so the guard passes while guarding nothing.
 *
 * Both problems are closed here rather than at each call site: the roots are
 * resolved against THIS file, and a grep that ERRORED (exit >= 2 — an
 * unreadable root, a missing binary) throws instead of returning `[]`.
 * `expectMatch` is the positive control the callers add on top: a needle that
 * must match a known file, so a rename of the needle cannot read as compliance.
 */

import { relative, resolve } from "node:path";

/** The monorepo root, resolved from this file — never from `process.cwd()`. */
export const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/**
 * Files under `roots` (repo-relative directories) whose text contains `needle`,
 * returned as SORTED repo-relative paths.
 *
 * @throws when grep itself failed, or when `expectMatch` names a file the
 * search did not return — either says the search is no longer asking the
 * question the caller thinks it is.
 */
export function grepFiles(
  needle: string,
  roots: string[],
  options: { expectMatch?: string[] } = {},
): string[] {
  const absoluteRoots = roots.map((root) => resolve(REPO_ROOT, root));
  const proc = Bun.spawnSync(["grep", "-rlF", needle, ...absoluteRoots]);
  // 0 = matched, 1 = no match, anything else = grep could not run the search.
  if (proc.exitCode !== 0 && proc.exitCode !== 1) {
    throw new Error(
      `grep failed (exit ${proc.exitCode}) for ${JSON.stringify(needle)} under ${absoluteRoots.join(", ")}: ${new TextDecoder().decode(proc.stderr).trim()}`,
    );
  }

  const files = new TextDecoder()
    .decode(proc.stdout)
    .split("\n")
    .filter(Boolean)
    .map((file) => relative(REPO_ROOT, file))
    .sort();

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
