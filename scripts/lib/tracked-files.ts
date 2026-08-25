// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * "Which files does this gate look at?", answered once for every gate that
 * answers it with `git ls-files`.
 *
 * Three gates drive their scan from the git INDEX rather than from the
 * filesystem — `scripts/lint.ts`, `scripts/lint-manifest-casing.ts` and
 * `scripts/verify-compose-defaults.ts` — and each of them had written out the
 * same spawn, the same exit-code throw, the same `split("\0")`, and the same
 * "matched nothing, so this gate would pass vacuously" throw. Three copies of a
 * rule is three places for it to drift, and the drift is silent in the
 * direction that matters: a copy that loses its empty-set throw reports a clean
 * run over zero files.
 *
 * ─── Why `git ls-files` and not a filesystem walk ────────────────────
 *
 * The index is the repo's own statement of what belongs to it. A filesystem
 * walk additionally sees whatever happens to be on this developer's disk, so an
 * untracked scratch file — a `zz-probe.ts`, a half-finished experiment — fails
 * the gate, fails `bun run check`, and blocks a push nobody asked it to block.
 * The converse property is the one worth having: a NEW file is covered the day
 * it is committed, with nothing to remember and no roster to extend.
 *
 * ─── The deleted-file allowance ──────────────────────────────────────
 *
 * `git ls-files` lists what is in the INDEX, which can name a file already
 * removed from the working tree (a `git rm` not yet committed, a refactor in
 * flight). Every consumer then has to decide what to do about a path it cannot
 * read, and the three of them had decided differently — an `existsSync`
 * pre-filter, an `ENOENT` catch around the read, and nothing at all. That is
 * settled here, once, with the pre-filter: a checkout mid-edit is not a lint
 * finding, and a caller that reads the returned paths can do so plainly.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Repo root, from this module's own location (`scripts/lib/`). */
const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Every extension eslint and the casing lint have an opinion about.
 *
 * `.ts`/`.tsx` come from `eslint.config.mjs`'s `ALL_TS`; `.js`/`.jsx`/`.mjs`/
 * `.cjs` come from the `js.configs.recommended` block beside it. That block is
 * what makes these four more than decoration — see `scripts/lint.ts` for the
 * measurement that put it there.
 *
 * `turbo.json`'s `//#lint` inputs restate this list. That restatement is
 * unavoidable (turbo reads JSON, not TypeScript) and is the one place the rule
 * is written twice on purpose; the comment there points back here.
 */
export const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"] as const;

/** Compose files, wherever they live (root, `examples/`, `test/setup/`). */
export const COMPOSE_GLOBS = ["*docker-compose*.yml", "*docker-compose*.yaml"] as const;

/**
 * Tracked, existing files matching `globs`, sorted.
 *
 * `what` names the population in the vacuity error — "no lintable file", "no
 * compose file" — so a gate that suddenly matches nothing says which gate it
 * was and what it was looking for.
 *
 * Throws when the match is empty, which is the whole reason this returns
 * through a function instead of being three inline spawns: an empty list makes
 * every downstream loop a no-op and every downstream report a tick.
 */
export function trackedFiles(globs: readonly string[], what: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "--", ...globs],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
    );
  }
  const files = result.stdout
    .toString()
    .split("\0")
    .filter(Boolean)
    .filter((rel) => existsSync(join(REPO_ROOT, rel)))
    .sort();
  if (files.length === 0) {
    throw new Error(`git ls-files matched no ${what} — the gate would pass vacuously.`);
  }
  return files;
}
