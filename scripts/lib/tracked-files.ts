// SPDX-License-Identifier: Apache-2.0
/// <reference types="bun" />

/**
 * "Which files does this gate look at?", answered once for every gate that
 * answers it with `git ls-files` — `scripts/lint.ts`,
 * `scripts/lint-manifest-casing.ts`, `scripts/verify-compose-defaults.ts`. One
 * spawn, one exit-code throw, one `split("\0")`, one "matched nothing, so this
 * gate would pass vacuously" throw: three copies of that rule are three places
 * for it to drift, silently in the direction that matters — a copy without the
 * empty-set throw reports a clean run over zero files.
 *
 * The INDEX, not a filesystem walk: it is the repo's own statement of what
 * belongs to it, while a walk also sees whatever sits on this developer's disk,
 * so an untracked scratch file (a `zz-probe.ts`, a half-finished experiment)
 * fails the gate, fails `bun run check`, and blocks a push nobody asked it to
 * block. The converse is the property worth having: a NEW file is covered the
 * day it is committed, with no roster to extend.
 *
 * The index can also name a file already gone from the working tree (a `git rm`
 * not yet committed, a refactor in flight), and what to do about a path that
 * cannot be read is the caller's call — so `onMissing` is REQUIRED, with no
 * default to inherit by accident. `"skip"` drops it, which `lint.ts` and
 * `lint-manifest-casing.ts` take: a checkout mid-edit is not a lint finding.
 * `"fail"` throws naming it, which `verify-compose-defaults.ts` takes: its file
 * list IS its coverage, and skipping silently lets it pass without reading the
 * root `docker-compose.yml` it exists for, the only trace being `9` turning
 * into `8` in a success line nobody diffs. That pair reaches the policy through
 * `trackedFiles`, which asks and applies in one call; `lint.ts` cannot, needing
 * the raw index list first (its `KNOWN_IGNORED` liveness check asks about the
 * index, not the disk) and applying the allowance only to what survives its
 * ignore partition — so the policy itself is the exported
 * `applyMissingFilePolicy`, which `lint.ts` calls.
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
 * Every `.env.example` the repo ships — the root one an operator copies to
 * `.env`, and the `examples/self-hosting/` one the self-hosting guide walks
 * through.
 *
 * Two gates read this population and they must read the SAME one:
 * `verify-env-docs.ts` asks whether every name in it has a `docs/ENV.md` row
 * (and whether every hard-required schema key appears in it), and
 * `verify-release-version.ts` asks whether the version pins inside it are
 * current. They had a verbatim copy each — in the very change that introduced
 * this module for shared constants — so a third example file added under a new
 * path would have had to be remembered twice, and the failure of forgetting is
 * a gate that quietly covers less while still printing a tick.
 *
 * The pattern is a `git ls-files` pathspec, not a shell glob: a leading `*`
 * makes it match at any depth INCLUDING zero, so it covers the root
 * `.env.example` as well as the nested one.
 */
export const ENV_EXAMPLE_GLOBS = ["*.env.example"] as const;

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
