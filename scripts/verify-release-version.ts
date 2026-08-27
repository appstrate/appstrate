// SPDX-License-Identifier: Apache-2.0

/**
 * Verify that the hardcoded release version shipped in operator-facing config
 * has not fallen behind the newest published release.
 *
 * ─── What was broken ─────────────────────────────────────────────────
 *
 * Every compose file this repo ships pins its images as
 * `${APPSTRATE_VERSION:-<version>}`. The interpolation is what an operator
 * overrides; the FALLBACK is what a self-hoster gets when they run the
 * documented `docker compose up -d` without setting the variable — which the
 * one-liner installer path does not force them to do. `docker-compose.yml`'s
 * own header says that fallback "MUST be bumped with every release", and
 * nothing checked it: measured at `v1.0.0-beta.53`, all five shipped compose
 * files still said `1.0.0-beta.41` (79 sites, twelve releases stale) and
 * `.env.example` said `1.0.0-beta.51` — a third value again.
 *
 * The #1201 image-trio guard structurally cannot catch this. It compares the
 * platform, `PI_IMAGE` and `SIDECAR_IMAGE` refs to EACH OTHER, and all three
 * take the same stale fallback from the same `${APPSTRATE_VERSION}`, so the
 * trio is perfectly coherent — coherently twelve releases old. Agreement
 * between the three says nothing about whether the shared value is current;
 * that is the question this gate asks, and the only one it asks.
 *
 * ─── What it compares against, and why that source works ─────────────
 *
 * There is no committed version file to compare against: `apps/cli/package.json`
 * reads `0.0.0` in the workspace and is stamped from `github.ref_name` by
 * `release.yml` at release time, and `CHANGELOG.md` carries only
 * `## [Unreleased]`. The platform's own release identity has exactly one
 * source — the git TAG. `release.yml` feeds it straight through as
 * `APP_VERSION=${{ github.ref_name }}` into the `Dockerfile`'s `ARG` → `ENV`,
 * and GHCR's `{{version}}` tag is the same value with the `v` stripped. So the
 * tag is not an approximation of the truth here; it IS the namespace the
 * fallback has to live in, and a fallback naming anything else names an image
 * that may not exist on GHCR at all.
 *
 * Two contexts, two readings of that one source:
 *
 *   1. EXACT — a tag push. `GITHUB_REF_TYPE=tag` and `GITHUB_REF_NAME=v1.2.3`
 *      is literally the value `release.yml` is about to bake into the image,
 *      so the fallback must EQUAL it. This is the arm that stops a release
 *      shipping a compose file pointing at the previous version.
 *
 *   2. FLOOR — everywhere else (a developer's machine, a PR run). The newest
 *      `v*` tag in the repo. The fallback must be greater than OR EQUAL TO it,
 *      never behind.
 *
 * The floor is deliberately not an equality, and that is the difference
 * between a gate and a deadlock. The release order is "bump in a PR, merge,
 * then tag", so during the bump PR the fallback is one release AHEAD of every
 * tag that exists. An equality check would fail exactly the PR that fixes the
 * problem — the same shape as the `check-consumer-versions.ts` major-release
 * deadlock that PR #1032 had to unwind. "Behind the newest release" is the
 * actual defect and is the only thing rejected.
 *
 * `git describe` is not used: it needs a commit-reachable tag and reports
 * nothing useful on a branch that predates one. `git tag --list` reads the ref
 * namespace directly, which is what a worktree and a tag-fetching checkout
 * both have.
 *
 * ─── When the source is missing ──────────────────────────────────────
 *
 * A `fetch-depth: 1` checkout without `fetch-tags` has no tags, and a gate
 * that silently degrades to "consistency only" there would report a tick over
 * the exact question it exists to answer — the failure mode
 * `scripts/lib/tracked-files.ts` documents at length for its own file list. So
 * a missing source THROWS, naming the fix, and `.github/workflows/check.yml`
 * sets `fetch-tags: true` so it does not happen in CI.
 *
 * Usage: bun scripts/verify-release-version.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersionsDesc, isValidVersion, normalizeVersion } from "@appstrate/core/semver";
import { COMPOSE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Ordering helpers over `@appstrate/core/semver`'s descending comparator, so
 * this gate does not add a direct `semver` dependency to the root manifest for
 * two predicates. `compareVersionsDesc` is `semver.rcompare`: it returns a
 * POSITIVE number when `a` is the LOWER version.
 */
const isBehind = (a: string, b: string): boolean => compareVersionsDesc(a, b) > 0;
const isAhead = (a: string, b: string): boolean => compareVersionsDesc(a, b) < 0;

/**
 * The verdict, and the only place it is written.
 *
 * Exported so `scripts/test/verify-release-version.test.ts` drives THIS
 * expression rather than a copy of it — a duplicated comparator in the test is
 * a test that passes against a reversed sign in the gate.
 *
 * The two modes are deliberately asymmetric. `exact` demands equality in both
 * directions: at a tag push the images being built carry that tag and nothing
 * else, so a fallback ahead of it is as wrong as one behind. `floor` rejects
 * only "behind", because the release order is bump → merge → tag and the PR
 * that fixes staleness is necessarily one release ahead of every tag that
 * exists yet.
 */
export function isStale(found: string, source: ReleaseSource): boolean {
  return source.mode === "exact" ? found !== source.version : isBehind(found, source.version);
}

/** `.env.example` at the root and under `examples/` — both are shipped to operators. */
const ENV_EXAMPLE_GLOBS = ["*.env.example"] as const;

/** One hardcoded release version, and where it was written. */
export interface VersionSite {
  file: string;
  line: number;
  /** The raw text as it appears, for the error message. */
  text: string;
  /** The version itself, normalized for comparison. */
  version: string;
}

/**
 * `${APPSTRATE_VERSION:-<version>}` — the compose fallback. The capture stops
 * at `}` so a ref like `…/appstrate-pi:${APPSTRATE_VERSION:-1.0.0-beta.53}`
 * yields just the version.
 */
const COMPOSE_FALLBACK = /\$\{APPSTRATE_VERSION:-([^}]+)\}/g;

/** `APPSTRATE_VERSION=<version>`, commented or not, in an `.env.example`. */
const ENV_ASSIGNMENT = /^\s*#?\s*APPSTRATE_VERSION=(.+)$/;

/**
 * A literal `ghcr.io/appstrate/<image>:<version>` pin — no interpolation.
 *
 * These are the commented `PI_IMAGE` / `SIDECAR_IMAGE` example pins in
 * `.env.example`, and they are in scope for the same reason the fallbacks are:
 * an operator copies them. They were the third value in the drift (`beta.51`
 * against the compose files' `beta.41`), so leaving them out would leave the
 * measured defect half-closed.
 */
const LITERAL_IMAGE_PIN = /ghcr\.io\/appstrate\/[a-z0-9-]+:([^\s"']+)/g;

/**
 * Every hardcoded release version in `content`.
 *
 * Non-version tag families are skipped rather than reported: `:latest`, `:1.0`
 * and `:sha-<sha>` are all tags `release.yml` publishes, and a compose file or
 * example pinned to one of them is making a deliberate choice this gate has no
 * opinion about. Only a value that parses as a full semver is a claim about
 * WHICH release, which is the only claim that can go stale.
 *
 * Pure — content in, sites out — so `scripts/test/verify-release-version.test.ts`
 * can drive it with synthetic text instead of a tracked file.
 */
export function findVersionSites(content: string): Omit<VersionSite, "file">[] {
  const sites: Omit<VersionSite, "file">[] = [];
  const lines = content.split("\n");

  for (const [index, line] of lines.entries()) {
    const add = (raw: string, text: string): void => {
      const version = normalizeVersion(raw);
      if (!isValidVersion(version)) return;
      sites.push({ line: index + 1, text, version });
    };

    for (const m of line.matchAll(COMPOSE_FALLBACK)) add(m[1]!, m[0]!);
    for (const m of line.matchAll(LITERAL_IMAGE_PIN)) add(m[1]!, m[0]!);

    const assignment = ENV_ASSIGNMENT.exec(line);
    if (assignment) add(assignment[1]!.trim(), line.trim());
  }

  return sites;
}

/** Where the release version came from, and how strictly it binds. */
export interface ReleaseSource {
  version: string;
  /** `exact` on a tag push; `floor` from the newest tag in the repo. */
  mode: "exact" | "floor";
  /** Human-readable provenance, printed in both the success and failure paths. */
  origin: string;
}

/**
 * Lists the repo's `v*` tags, newest first — the ONE ambient input this module
 * has, isolated behind a function type so callers can supply it.
 *
 * `scripts/test/verify-release-version.test.ts` passes a literal list. That is
 * not a stylistic preference: the tests used to call the real git command, so
 * they asserted on whatever tags the checkout happened to carry, and they
 * FAILED in the `Unit tests` job — `.github/workflows/test.yml` checks out with
 * `actions/checkout` defaults (no `fetch-tags`), so the ref namespace is empty
 * there and the "no source" throw fired inside a test that expected a floor.
 * The same emptiness occurs in a shallow clone, a container, or a fresh
 * worktree. A unit test must not be able to read a different answer depending
 * on where it runs.
 */
export type TagLister = () => string[];

/**
 * The real lister: `v*` tags from this checkout, in git's own semver-aware
 * order (`--sort=-v:refname` puts `v1.0.0-beta.53` above `v1.0.0-beta.9`,
 * where a lexical sort would not).
 *
 * Returns `[]` for a checkout with no tags — "no tags" is a legitimate state
 * this function reports, not an error it raises. A git failure (no repo, git
 * missing) IS an error and throws, because that is the gate being unable to
 * look rather than looking and finding nothing.
 */
export const gitTags: TagLister = () => {
  const result = Bun.spawnSync({
    cmd: ["git", "tag", "--list", "v*", "--sort=-v:refname"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git tag --list failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/**
 * The newest tag in `tags` that parses as semver, or `null`.
 *
 * Prereleases sort BELOW their release in `v:refname`, which is correct, but a
 * tag that is not valid semver would sort anywhere — drop those first rather
 * than let one become the floor.
 */
function newestTag(tags: string[]): string | null {
  for (const tag of tags) {
    if (isValidVersion(normalizeVersion(tag))) return tag;
  }
  return null;
}

/**
 * The release version this checkout must not be behind.
 *
 * Throws rather than degrading when neither source is available — see the
 * header. Both inputs are parameters: `env` so the test can drive both arms
 * without mutating `process.env` for the whole test process, `listTags` so it
 * never depends on the checkout's tags (see {@link TagLister}).
 */
export function resolveReleaseSource(
  env: Record<string, string | undefined>,
  listTags: TagLister = gitTags,
): ReleaseSource {
  const refName = env.GITHUB_REF_NAME?.trim();
  if (env.GITHUB_REF_TYPE === "tag" && refName && isValidVersion(normalizeVersion(refName))) {
    return {
      version: normalizeVersion(refName),
      mode: "exact",
      origin: `GITHUB_REF_NAME=${refName} (the tag being released — the same value release.yml bakes in as APP_VERSION)`,
    };
  }

  const tag = newestTag(listTags());
  if (tag) {
    return {
      version: normalizeVersion(tag),
      mode: "floor",
      origin: `newest git tag ${tag}`,
    };
  }

  throw new Error(
    "Cannot determine the current release version: this checkout has no `v*` tag and no " +
      "release ref.\n" +
      "  • In CI: the checkout step needs `fetch-tags: true` (see .github/workflows/check.yml).\n" +
      "  • Locally: `git fetch --tags`.\n" +
      "Refusing to pass without comparing — a version gate that cannot read the version is " +
      "not a gate.",
  );
}

function main(): number {
  const files = [
    ...trackedFiles(COMPOSE_GLOBS, "compose file", "fail"),
    ...trackedFiles(ENV_EXAMPLE_GLOBS, "env example file", "fail"),
  ];

  const sites: VersionSite[] = [];
  for (const file of files) {
    const content = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const site of findVersionSites(content)) sites.push({ ...site, file });
  }

  // Vacuity floor, same rule as `trackedFiles`: zero sites means every
  // comparison below is a no-op and the success line is a lie. The pattern
  // changing shape (a compose rewrite, a rename of APPSTRATE_VERSION) is
  // exactly how this gate would stop looking without saying so.
  if (sites.length === 0) {
    console.error(
      "\x1b[31m✗\x1b[0m verify-release-version: found no hardcoded release version in any " +
        `of the ${files.length} shipped compose/env-example files — the gate would pass ` +
        "vacuously. Did the `${APPSTRATE_VERSION:-…}` shape change?",
    );
    return 1;
  }

  const source = resolveReleaseSource(process.env);

  // Disagreement between sites is its own defect and is reported first: a
  // half-done bump leaves some operators on one version and some on another,
  // and the "is it current?" question below has no single subject until it is
  // resolved.
  const distinct = [...new Set(sites.map((s) => s.version))].sort(compareVersionsDesc);
  if (distinct.length > 1) {
    console.error(
      `\x1b[31m✗\x1b[0m verify-release-version: the shipped files disagree about the release ` +
        `version — ${distinct.length} distinct values (${distinct.join(", ")}).\n` +
        `Every \`\${APPSTRATE_VERSION:-…}\` fallback and every literal image pin must name ONE ` +
        `version, and it must be ${source.version} (${source.origin}).\n`,
    );
    for (const s of sites.filter((s) => s.version !== source.version)) {
      console.error(`  \x1b[1m${s.file}:${s.line}\x1b[0m  ${s.text}  → expected ${source.version}`);
    }
    return 1;
  }

  const found = distinct[0]!;
  if (isStale(found, source)) {
    const verdict =
      source.mode === "exact"
        ? `must EQUAL the tag being released (${source.version})`
        : `is BEHIND the newest release (${source.version})`;
    console.error(
      `\x1b[31m✗\x1b[0m verify-release-version: the shipped fallback version ${found} ${verdict}.\n\n` +
        `Source of truth: ${source.origin}.\n` +
        `A self-hoster who runs the documented \`docker compose up -d\` without setting ` +
        `APPSTRATE_VERSION gets this fallback, so a stale value silently installs an old ` +
        `platform — and the image-trio boot guard cannot see it, because all three images take ` +
        `the SAME stale fallback and therefore agree.\n\n` +
        `Fix: bump all ${sites.length} site(s) to ${source.version}:\n`,
    );
    for (const s of sites) {
      console.error(`  \x1b[1m${s.file}:${s.line}\x1b[0m  ${s.text}`);
    }
    return 1;
  }

  const ahead = source.mode === "floor" && isAhead(found, source.version);
  console.log(
    `\x1b[32m✓\x1b[0m verify-release-version: ${sites.length} hardcoded version site(s) across ` +
      `${files.length} shipped compose/env-example files all name ${found}` +
      (ahead ? ` (ahead of ${source.origin} — a release bump in flight)` : ` (${source.origin})`) +
      `.`,
  );
  return 0;
}

// Guarded so the test file can import the pure helpers above without the gate
// exiting the test process on import — same pattern as verify-compose-defaults.ts.
if (import.meta.main) {
  process.exit(main());
}
