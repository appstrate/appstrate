#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-commit secret scan — gitleaks over the STAGED diff.
 *
 * `.github/workflows/security.yml` already runs gitleaks, but it runs on a
 * pushed branch: by the time it is red the secret is in git history, and
 * history is the expensive half to clean up. Rotating the credential is
 * unavoidable either way; a rewritten branch, a force-push and every open PR
 * rebased on top of it are not. This moves the same check to the last moment it
 * is still cheap.
 *
 * ─── Why a missing gitleaks does NOT block the commit ─────────────────
 *
 * This is the one place in this repo where "no silent degradation" is
 * deliberately not applied as a hard block, so the reasoning is written down
 * rather than left to be re-derived by whoever next reads it as an oversight.
 *
 * gitleaks is a Go binary that is not, and cannot be, a `bun install`
 * dependency: it has no npm distribution this repo pins, and `.husky/` runs on
 * whatever a contributor's machine happens to carry. Hard-blocking every commit
 * from anybody who has not installed it turns a first-time external
 * contribution into a toolchain errand, for a check that is NOT the
 * authoritative one — CI is, it runs on every push and every pull_request, and
 * it fails the same finding.
 *
 * The degradation is also not silent, which is the property the doctrine
 * actually protects: the absent branch prints, loudly and on every commit,
 * what is missing and the one command that fixes it. A developer who ignores it
 * gets caught by CI; a developer who installs it gets the finding before the
 * commit exists.
 *
 * There is deliberately **no** environment variable to skip the scan when
 * gitleaks IS installed. A skip switch would be reached for exactly once — on
 * the commit that is in a hurry — and that is the commit this hook exists for.
 * The escape hatch for a genuine false positive is gitleaks' own, in the repo
 * and reviewable: a `gitleaks:allow` comment on the line, or an entry in
 * `.gitleaksignore` keyed on the fingerprint the finding prints.
 *
 * ─── Why `gitleaks git --staged` and not `gitleaks protect --staged` ──
 *
 * Measured 2026-09-07 against gitleaks 8.30.1, the version
 * `.github/workflows/security.yml` pins. Both forms detect the same staged
 * secret and both exit 1 — but `protect` no longer appears under "Available
 * Commands" in `gitleaks --help`, where `git` does. It is a surviving legacy
 * alias, and a hook built on an undocumented alias is one major version away
 * from failing in a way that reads like "gitleaks is broken".
 */

/**
 * `--verbose` is not decoration: without it gitleaks reports `leaks found: 1`
 * and nothing else, which tells the contributor a commit was blocked but not
 * by what or where. With it — and `--redact`, which is why the pair is safe —
 * the output names the rule, the file, the line and the fingerprint to put in
 * `.gitleaksignore` if the finding is wrong.
 */
const GITLEAKS_ARGS = ["git", "--staged", "--redact", "--verbose", "--no-banner"] as const;

const INSTALL_HINT =
  "⚠️  gitleaks is not installed — staged changes were NOT scanned for secrets. " +
  "Install it (`brew install gitleaks`, or https://github.com/gitleaks/gitleaks#installing) " +
  "to catch a leaked credential before it enters git history. CI scans every push regardless, " +
  "so this commit is not unchecked — only checked later, when a leak costs a history rewrite.";

const gitleaks = Bun.which("gitleaks");

if (gitleaks === null) {
  console.warn(INSTALL_HINT);
  process.exit(0);
}

const run = Bun.spawnSync({
  cmd: [gitleaks, ...GITLEAKS_ARGS],
  stdout: "inherit",
  stderr: "inherit",
});

// Any non-zero exit blocks. gitleaks returns 1 both for "leaks found" and for
// its own failures (bad config, unreadable repo), and the two are not worth
// telling apart here: it has already printed which one happened on the stderr
// inherited above, and neither is a state in which this commit should proceed
// unscanned.
if (run.exitCode !== 0) {
  console.error(
    "❌ commit blocked: gitleaks found a secret in the staged diff (or failed to scan it). " +
      "Remove the credential and re-stage. If the finding is wrong, add a `gitleaks:allow` " +
      "comment on the line, or the printed fingerprint to `.gitleaksignore` — both are " +
      "reviewable in the diff, which is the point.",
  );
  process.exit(1);
}
