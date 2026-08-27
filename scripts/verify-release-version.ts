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
 * ─── Which CI job makes each arm fire ────────────────────────────────
 *
 * An arm is only a protection where something RUNS it, and the two arms are
 * run by two different workflows on purpose — the floor cannot substitute for
 * the exact one:
 *
 *   - FLOOR: `.github/workflows/check.yml` (`bun run check`), on every push to
 *     and PR against `main`. It answers "is what we ship behind what we have
 *     already released?".
 *
 *   - EXACT: the `verify-version` preflight job in `.github/workflows/release.yml`,
 *     which every publishing job `needs:`. It answers "does what we ship name
 *     the tag we are publishing RIGHT NOW?", and nothing else can: at the
 *     moment `v1.2.3` is pushed, the newest tag the floor arm can see IS
 *     `v1.2.3`, so a compose file left at `1.2.2` was already passing the floor
 *     on the PR that merged it. The window between "merge the bump" and "push
 *     the tag" is exactly where a half-done bump hides, and only a tag-time
 *     comparison closes it.
 *
 * `check.yml` triggers on `push: branches: [main]` / `pull_request:` only, so
 * it never sees a tag ref and never takes the exact arm. If the release
 * preflight is ever removed, the exact arm stops being reachable in CI and this
 * gate silently drops back to "not behind" — half of what the header claims.
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
import { COMPOSE_GLOBS, ENV_EXAMPLE_GLOBS, trackedFiles } from "./lib/tracked-files.ts";

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
 * A value that sat in a version site and is neither a release version nor one
 * of the tag families this gate deliberately ignores.
 *
 * This is its own outcome, not a third kind of skip, because the two failures
 * it separates are the ones a silent `return` used to merge. `add()` bailed on
 * anything `isValidVersion` rejected and recorded NOTHING, so a bump that
 * touched 81 of 82 sites and mangled the 82nd — `${APPSTRATE_VERSION:-1.0.0.beta.54}`,
 * dots where the `-beta` belongs — produced "81 hardcoded version site(s) …
 * all name 1.0.0-beta.54" and exit 0, over a compose file naming a tag GHCR
 * does not have. The count in the success line is the only trace, and nobody
 * diffs a count. The vacuity floor cannot help: it fires when ALL sites vanish,
 * and 81 of 82 is not zero.
 */
export interface MalformedSite {
  file: string;
  line: number;
  /** The full matched text, for the error message. */
  text: string;
  /** Just the unparseable value, so the message can name what was wrong. */
  raw: string;
}

/** What one file's content yielded: the versions, the junk, and the count of deliberate skips. */
export interface Scan {
  sites: Omit<VersionSite, "file">[];
  malformed: Omit<MalformedSite, "file">[];
  /** Matches skipped as a known non-version tag family — reported in the success line. */
  skipped: number;
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
 *
 * The character class excludes `$`, `{` and a backtick, and that is load-bearing
 * now that a non-parsing capture is REPORTED rather than dropped. Without the
 * first two, this pattern also matches the interpolated form — the tag part of
 * `ghcr.io/appstrate/appstrate-pi:${APPSTRATE_VERSION:-1.0.0-beta.53}` captures
 * as the whole `${…}` expression, which parses as nothing. `COMPOSE_FALLBACK`
 * has already recorded that line's real version, so the second match was pure
 * noise: 84 of them across the tracked files, every one of which would now be a
 * false finding. The backtick excludes the markdown quoting in prose comments
 * (`` `ghcr.io/appstrate/appstrate:latest` ``), which otherwise captures
 * ``latest` `` and misses the alias family by one character.
 */
const LITERAL_IMAGE_PIN = /ghcr\.io\/appstrate\/[a-z0-9-]+:([^\s"'`${]+)/g;

/**
 * Tag families `release.yml` also publishes, which are not claims about WHICH
 * release and therefore cannot go stale.
 *
 * Read straight off the `docker/metadata-action` config in
 * `.github/workflows/release.yml`: `flavor: latest=auto` gives `latest`,
 * `type=semver,pattern={{major}}.{{minor}}` gives `1.0`, and
 * `type=sha,prefix=sha-` gives `sha-<sha>`. Pinning to one of these is a
 * deliberate operator choice about which CHANNEL to track — the same reasoning
 * the #1201 image-trio boot guard applies — so the gate has no opinion about
 * it. The list is closed on purpose: anything outside it is junk, not a family
 * nobody thought of, and the fix for a genuinely new family is to add it here
 * with the metadata-action line that produces it.
 */
const ALIAS_TAG_FAMILY = /^(?:latest|\d+\.\d+|sha-[0-9a-f]{7,40})$/;

/**
 * An angle-bracketed documentation placeholder, e.g. the `${APPSTRATE_VERSION:-<version>}`
 * that `docker-compose.yml`'s own RELEASE CHECKLIST comment quotes when it
 * explains the shape an operator has to bump. It is prose about the pattern,
 * not an instance of it.
 */
const DOC_PLACEHOLDER = /^<[^>]*>$/;

/**
 * Every hardcoded release version in `content`, plus everything that looked
 * like one and was not.
 *
 * Three outcomes, not two — see {@link MalformedSite}. A value that parses as
 * semver is a version site. A value in a known alias family or a documentation
 * placeholder is COUNTED as skipped and otherwise ignored. Anything else
 * matched the version-site shape without being a version, which is the shape a
 * mangled bump leaves behind, and it is reported.
 *
 * Pure — content in, outcomes out — so `scripts/test/verify-release-version.test.ts`
 * can drive it with synthetic text instead of a tracked file.
 */
export function findVersionSites(content: string): Scan {
  const sites: Omit<VersionSite, "file">[] = [];
  const malformed: Omit<MalformedSite, "file">[] = [];
  let skipped = 0;
  const lines = content.split("\n");

  for (const [index, line] of lines.entries()) {
    const add = (rawInput: string, text: string): void => {
      const raw = rawInput.trim();
      const version = normalizeVersion(raw);
      if (isValidVersion(version)) {
        sites.push({ line: index + 1, text, version });
        return;
      }
      if (ALIAS_TAG_FAMILY.test(raw) || DOC_PLACEHOLDER.test(raw)) {
        skipped += 1;
        return;
      }
      malformed.push({ line: index + 1, text, raw });
    };

    for (const m of line.matchAll(COMPOSE_FALLBACK)) add(m[1]!, m[0]!);
    for (const m of line.matchAll(LITERAL_IMAGE_PIN)) add(m[1]!, m[0]!);

    const assignment = ENV_ASSIGNMENT.exec(line);
    if (assignment) add(assignment[1]!, line.trim());
  }

  return { sites, malformed, skipped };
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
  return parseGitTags(result.exitCode, result.stdout.toString(), result.stderr.toString());
};

/**
 * `git tag --list`'s result, turned into the list — or an error.
 *
 * Split out of {@link gitTags} for one reason: the non-zero-exit branch ENDS
 * the gate, and a branch that ends a gate needs an assertion. Reaching it
 * through the real spawn would mean running `git` somewhere that is not a
 * repository, which is a test that depends on where the runner's temp
 * directory happens to sit; taking the three values as arguments makes it a
 * fact about this function.
 *
 * The distinction it draws is the one the header cares about: exit 0 with no
 * output means "looked, found no tags", which is a legitimate state
 * `resolveReleaseSource` handles; a non-zero exit means the gate could not
 * LOOK, and passing on that is how a version gate stops comparing without
 * saying so.
 */
export function parseGitTags(exitCode: number, stdout: string, stderr: string): string[] {
  if (exitCode !== 0) {
    throw new Error(`git tag --list failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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

/**
 * Everything `main` reaches for outside itself, so a test can reach in.
 *
 * Every branch below ENDS THE GATE — the vacuity floor, the malformed report,
 * the disagreement report, the staleness report — and each was previously
 * unreachable from a test, because `main` was neither exported nor separable
 * from `trackedFiles` + `readFileSync` + `process.env`. Deleting any one of
 * them left the suite green, which is the same "passes without checking"
 * failure the gate itself exists to prevent, one level up.
 *
 * The defaults ARE the production wiring, and they are resolved inside `main`
 * rather than in the parameter list so that importing this module still spawns
 * no `git` and reads no file.
 */
export interface MainDeps {
  /** The files to scan. Default: every tracked compose and `.env.example` file. */
  files?: readonly string[];
  /** Reads one repo-relative path. Default: from disk. */
  readFile?: (relativePath: string) => string;
  /** The release source. Default: {@link resolveReleaseSource} over the real env + git tags. */
  resolveSource?: () => ReleaseSource;
  out?: (message: string) => void;
  err?: (message: string) => void;
}

export function main(deps: MainDeps = {}): number {
  const readFile =
    deps.readFile ?? ((rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf-8"));
  const out = deps.out ?? ((m: string): void => console.log(m));
  const err = deps.err ?? ((m: string): void => console.error(m));
  const files = deps.files ?? [
    ...trackedFiles(COMPOSE_GLOBS, "compose file", "fail"),
    ...trackedFiles(ENV_EXAMPLE_GLOBS, "env example file", "fail"),
  ];

  const sites: VersionSite[] = [];
  const malformed: MalformedSite[] = [];
  let skipped = 0;
  for (const file of files) {
    const scan = findVersionSites(readFile(file));
    for (const site of scan.sites) sites.push({ ...site, file });
    for (const bad of scan.malformed) malformed.push({ ...bad, file });
    skipped += scan.skipped;
  }

  // Reported before anything else, because a malformed site makes every count
  // below a lie about a smaller population than the one on disk. See
  // `MalformedSite`: this is the branch that catches a bump which touched 81 of
  // 82 sites, where the vacuity floor (all-or-nothing) sees nothing wrong.
  if (malformed.length > 0) {
    err(
      `\x1b[31m✗\x1b[0m verify-release-version: ${malformed.length} version site(s) hold a value ` +
        `that is neither a release version nor a tag family this gate skips ` +
        `(\`latest\`, \`MAJOR.MINOR\`, \`sha-…\`).\n\n` +
        `A site the gate cannot parse is a site it cannot compare, and dropping it silently is ` +
        `how a half-finished bump ships: the other ${sites.length} site(s) agree, the success ` +
        `line counts only them, and the odd one out names an image tag GHCR does not have.\n`,
    );
    for (const m of malformed) {
      err(
        `  \x1b[1m${m.file}:${m.line}\x1b[0m  ${m.text}  → \`${m.raw}\` does not parse as a version`,
      );
    }
    err("");
    return 1;
  }

  // Vacuity floor, same rule as `trackedFiles`: zero sites means every
  // comparison below is a no-op and the success line is a lie. The pattern
  // changing shape (a compose rewrite, a rename of APPSTRATE_VERSION) is
  // exactly how this gate would stop looking without saying so.
  if (sites.length === 0) {
    err(
      "\x1b[31m✗\x1b[0m verify-release-version: found no hardcoded release version in any " +
        `of the ${files.length} tracked compose and .env.example files — the gate would pass ` +
        "vacuously. Did the `${APPSTRATE_VERSION:-…}` shape change?",
    );
    return 1;
  }

  const source = (deps.resolveSource ?? ((): ReleaseSource => resolveReleaseSource(process.env)))();

  // Disagreement between sites is its own defect and is reported first: a
  // half-done bump leaves some operators on one version and some on another,
  // and the "is it current?" question below has no single subject until it is
  // resolved.
  const distinct = [...new Set(sites.map((s) => s.version))].sort(compareVersionsDesc);
  if (distinct.length > 1) {
    err(
      `\x1b[31m✗\x1b[0m verify-release-version: the shipped files disagree about the release ` +
        `version — ${distinct.length} distinct values (${distinct.join(", ")}).\n` +
        `Every \`\${APPSTRATE_VERSION:-…}\` fallback and every literal image pin must name ONE ` +
        `version, and it must be ${source.version} (${source.origin}).\n`,
    );
    for (const s of sites.filter((s) => s.version !== source.version)) {
      err(`  \x1b[1m${s.file}:${s.line}\x1b[0m  ${s.text}  → expected ${source.version}`);
    }
    return 1;
  }

  const found = distinct[0]!;
  if (isStale(found, source)) {
    const verdict =
      source.mode === "exact"
        ? `must EQUAL the tag being released (${source.version})`
        : `is BEHIND the newest release (${source.version})`;
    err(
      `\x1b[31m✗\x1b[0m verify-release-version: the shipped fallback version ${found} ${verdict}.\n\n` +
        `Source of truth: ${source.origin}.\n` +
        `A self-hoster who runs the documented \`docker compose up -d\` without setting ` +
        `APPSTRATE_VERSION gets this fallback, so a stale value silently installs an old ` +
        `platform — and the image-trio boot guard cannot see it, because all three images take ` +
        `the SAME stale fallback and therefore agree.\n\n` +
        `Fix: bump all ${sites.length} site(s) to ${source.version}:\n`,
    );
    for (const s of sites) {
      err(`  \x1b[1m${s.file}:${s.line}\x1b[0m  ${s.text}`);
    }
    return 1;
  }

  const ahead = source.mode === "floor" && isAhead(found, source.version);
  out(
    `\x1b[32m✓\x1b[0m verify-release-version: ${sites.length} hardcoded version site(s) across ` +
      `${files.length} tracked compose and .env.example files all name ${found}` +
      (ahead ? ` (ahead of ${source.origin} — a release bump in flight)` : ` (${source.origin})`) +
      `; ${skipped} alias-tag pin(s) skipped, 0 unparseable.`,
  );
  return 0;
}

// Guarded so the test file can import the pure helpers above without the gate
// exiting the test process on import — same pattern as verify-compose-defaults.ts.
if (import.meta.main) {
  process.exit(main());
}
