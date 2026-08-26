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
 * ─── The deleted-file allowance is a per-caller CHOICE ───────────────
 *
 * `git ls-files` lists what is in the INDEX, which can name a file already
 * removed from the working tree (a `git rm` not yet committed, a refactor in
 * flight). Every consumer then has to decide what to do about a path it cannot
 * read, and the three of them had decided differently — an `existsSync`
 * pre-filter, an `ENOENT` catch around the read, and nothing at all.
 *
 * Unifying that on a silent pre-filter was a mistake, and a measured one.
 * `verify-compose-defaults.ts` is the gate that OWNS the root
 * `docker-compose.yml`; before the pre-filter it crashed on a tracked compose
 * file missing from the worktree, which is loud and correct. After it:
 *
 *     $ rm docker-compose.yml && bun scripts/verify-compose-defaults.ts
 *     ✓ verify-compose-defaults: no duplicated env defaults across 8 compose files …
 *     EXIT=0
 *
 * The gate passed without reading the file it exists for, and the only trace
 * was `9` turning into `8` in a success line nobody diffs. An allowance that
 * one caller wants is not an allowance every caller wants, so `onMissing` is a
 * REQUIRED argument: there is no default to inherit by accident, and the choice
 * is written at the call site next to the reason for it.
 *
 *   - `"skip"` — a path in the index that is gone from disk is dropped.
 *     `lint.ts` and `lint-manifest-casing.ts` take this: a checkout mid-edit is
 *     not a lint finding.
 *   - `"fail"` — the same path throws, naming it. `verify-compose-defaults.ts`
 *     takes this: its file list IS its coverage, so losing one silently is the
 *     failure the gate is for.
 *
 * `lint-manifest-casing.ts` and `verify-compose-defaults.ts` reach the policy
 * through `trackedFiles`, which asks the index and applies the answer in one
 * call. `lint.ts` cannot: it needs the raw INDEX list first (its `KNOWN_IGNORED`
 * liveness check is a question about the index, not about the disk), and the
 * allowance applies only to what survives its ignore partition. So the policy
 * itself is `applyMissingFilePolicy`, exported, and `lint.ts` calls that —
 * rather than hand-rolling a fourth copy of the rule, which is what it did while
 * this comment claimed it was a caller.
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
 * What a caller wants done about an index entry with no file behind it.
 *
 * Required, not defaulted — see the header. The two answers are both correct,
 * for different gates, and the wrong one is invisible in exactly the direction
 * that matters (a gate that reads fewer files still prints a tick).
 */
type MissingFilePolicy = "skip" | "fail";

/**
 * Tracked paths matching `globs`, sorted — straight from the index, with no
 * question asked about the working tree.
 *
 * `what` names the population in the vacuity error — "no lintable file", "no
 * compose file" — so a gate that suddenly matches nothing says which gate it
 * was and what it was looking for.
 *
 * Throws when the match is empty, which is the whole reason this returns
 * through a function instead of being three inline spawns: an empty list makes
 * every downstream loop a no-op and every downstream report a tick.
 *
 * Exported for the one caller that needs the INDEX list rather than the
 * on-disk one: `scripts/lint.ts` checks its `KNOWN_IGNORED` liveness against
 * this list, so that deleting a generated-and-ignored file reports the deletion
 * instead of a drift that has not happened.
 */
export function trackedIndexFiles(globs: readonly string[], what: string): string[] {
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
  const files = result.stdout.toString().split("\0").filter(Boolean).sort();
  if (files.length === 0) {
    throw new Error(`git ls-files matched no ${what} — the gate would pass vacuously.`);
  }
  return files;
}

/** The subset of `files` the index names but the working tree does not have. */
export function missingFromWorktree(files: readonly string[]): string[] {
  return files.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
}

/**
 * The policy itself: `files` minus `missing`, or a throw, depending on what the
 * caller asked for.
 *
 * Separate from `trackedFiles` and exported for two reasons. `lint.ts` needs the
 * policy without the index lookup that normally precedes it (see the header),
 * and — the reason it is worth an export on its own — a rule whose two branches
 * both END A GATE is a rule whose two branches both need an assertion. Taking
 * the two lists as arguments lets `scripts/test/tracked-files.test.ts` drive
 * both, plus the empty-remainder case, against synthetic input, instead of
 * deleting a tracked file to reach one of them.
 */
export function applyMissingFilePolicy(
  files: readonly string[],
  missing: readonly string[],
  what: string,
  onMissing: MissingFilePolicy,
): string[] {
  if (missing.length === 0) return [...files];

  if (onMissing === "fail") {
    throw new Error(
      `git ls-files names ${missing.length} tracked ${what}(s) that the working tree does not ` +
        `have:\n${missing.map((f) => `  - ${f}`).join("\n")}\n` +
        `This gate reads every ${what} it is handed, so skipping one would shrink its coverage ` +
        `without shrinking its success line. Restore the file, or \`git rm\` it so it leaves the ` +
        `index too.`,
    );
  }

  const gone = new Set(missing);
  const present = files.filter((rel) => !gone.has(rel));
  if (present.length === 0) {
    throw new Error(
      `git ls-files matched ${files.length} ${what}(s) but none of them exist in the working ` +
        `tree — the gate would pass vacuously.`,
    );
  }
  return present;
}

/**
 * Tracked files matching `globs`, sorted, with the worktree-existence question
 * answered the way THIS caller wants it answered.
 *
 * Throws on an empty match (see `trackedIndexFiles`), and — under
 * `onMissing: "fail"` — on any index entry with no file behind it.
 */
export function trackedFiles(
  globs: readonly string[],
  what: string,
  onMissing: MissingFilePolicy,
): string[] {
  const files = trackedIndexFiles(globs, what);
  return applyMissingFilePolicy(files, missingFromWorktree(files), what, onMissing);
}
