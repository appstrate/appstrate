// SPDX-License-Identifier: Apache-2.0

/**
 * The release-version gate's two questions, held apart.
 *
 * A gate like this fails in exactly one interesting way — vacuously — so every
 * case below asserts BOTH halves of a discrimination: the input that must be
 * rejected AND a neighbouring input that must be accepted. "Found no findings"
 * is what the absent gate said for twelve releases; a test that only asserts
 * the green half would have said the same thing.
 */

import { describe, it, expect } from "bun:test";
import {
  findVersionSites,
  gitTags,
  isStale,
  main,
  parseGitTags,
  resolveReleaseSource,
  type ReleaseSource,
} from "../verify-release-version.ts";

/** A compose file's shape, reduced to the one line the gate reads. */
const compose = (version: string): string =>
  [
    "services:",
    "  appstrate:",
    `    image: ghcr.io/appstrate/appstrate:\${APPSTRATE_VERSION:-${version}}`,
    "    environment:",
    `      - PI_IMAGE=ghcr.io/appstrate/appstrate-pi:\${APPSTRATE_VERSION:-${version}}`,
  ].join("\n");

/** The version sites only — most cases below care about nothing else. */
const sitesOf = (content: string): ReturnType<typeof findVersionSites>["sites"] =>
  findVersionSites(content).sites;

describe("findVersionSites", () => {
  it("finds every `${APPSTRATE_VERSION:-…}` fallback, with its line", () => {
    const sites = sitesOf(compose("1.0.0-beta.53"));
    expect(sites.map((s) => s.version)).toEqual(["1.0.0-beta.53", "1.0.0-beta.53"]);
    expect(sites.map((s) => s.line)).toEqual([3, 5]);
  });

  it("finds a commented `APPSTRATE_VERSION=` assignment in an .env.example", () => {
    const sites = sitesOf("# APPSTRATE_VERSION=1.0.0-beta.53\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.version).toBe("1.0.0-beta.53");
  });

  it("finds a LITERAL image pin — the third value in the measured drift", () => {
    // `.env.example` carried `beta.51` example pins while every compose file
    // said `beta.41`. A gate that read only the interpolated fallbacks would
    // have called that repo clean.
    const sites = sitesOf("# PI_IMAGE=ghcr.io/appstrate/appstrate-pi:1.0.0-beta.51\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.version).toBe("1.0.0-beta.51");
  });

  it("strips a leading `v` so a tag-shaped value compares equal to a bare one", () => {
    expect(sitesOf(compose("v1.0.0-beta.53"))[0]!.version).toBe("1.0.0-beta.53");
  });

  it("ignores the alias tag families the release also publishes", () => {
    // `latest`, `1.0` and `sha-<sha>` are all real tags `release.yml` pushes.
    // Pinning to one is a deliberate operator choice about WHICH CHANNEL, not a
    // claim about which release, so it cannot go stale and is not this gate's
    // business. Reporting them would make the rule unsatisfiable — the same
    // reasoning the image-trio boot guard applies to `APP_VERSION`.
    const content = [
      compose("latest"),
      compose("1.0"),
      compose("sha-0a1b2c3"),
      "# RUNNER_IMAGE_NODE=ghcr.io/appstrate/appstrate-mcp-runner-node:latest",
    ].join("\n");
    const scan = findVersionSites(content);
    expect(scan.sites).toHaveLength(0);
    // Counted, not dropped: the skip is a decision the success line reports.
    expect(scan.skipped).toBe(7);
    expect(scan.malformed).toHaveLength(0);
  });

  it("does not fire on an unrelated registry", () => {
    expect(sitesOf("    image: docker.io/library/postgres:16.4\n")).toHaveLength(0);
  });

  // ─── The defect: an unparseable site used to vanish ─────────────────────
  //
  // `add()` returned early on `!isValidVersion` and recorded nothing, so a
  // malformed site was indistinguishable from no site at all.

  it("REPORTS a value that matched the shape but is not a version", () => {
    // Mutation caught: deleting the `malformed.push(…)` arm, or widening
    // ALIAS_TAG_FAMILY to `/./`, makes this return an empty list.
    const scan = findVersionSites(compose("1.0.0.beta.54"));
    expect(scan.sites).toHaveLength(0);
    expect(scan.malformed.map((m) => m.raw)).toEqual(["1.0.0.beta.54", "1.0.0.beta.54"]);
    expect(scan.malformed.map((m) => m.line)).toEqual([3, 5]);
  });

  it("keeps the good sites AND the malformed one — the 81-of-82 shape", () => {
    // The scenario the silent drop hid: a bump touches every site but one.
    // Both halves must survive the scan, or the report cannot say which file
    // was left behind.
    const scan = findVersionSites([compose("1.0.0-beta.54"), compose("1.0.0.beta.54")].join("\n"));
    expect(scan.sites).toHaveLength(2);
    expect(scan.malformed).toHaveLength(2);
  });

  it("separates the two classes: an alias is skipped, junk is reported", () => {
    // The discrimination this fix is about. A single input carrying one of
    // each: a test asserting only the alias half would pass against a parser
    // that swallowed both.
    const scan = findVersionSites([compose("latest"), compose("beta.54")].join("\n"));
    expect(scan.skipped).toBe(2);
    expect(scan.malformed.map((m) => m.raw)).toEqual(["beta.54", "beta.54"]);
  });

  it("treats the compose header's `<version>` placeholder as prose, not junk", () => {
    // `docker-compose.yml`'s RELEASE CHECKLIST comment quotes the shape it is
    // telling you to bump. Reporting it would make the gate red on a clean
    // repo, which is the other way a gate stops being used.
    const scan = findVersionSites("# the `${APPSTRATE_VERSION:-<version>}` fallback below\n");
    expect(scan.malformed).toHaveLength(0);
    expect(scan.skipped).toBe(1);
  });

  it("does not double-count an interpolated image ref as an unparseable pin", () => {
    // `LITERAL_IMAGE_PIN` used to also match the tag half of
    // `…/appstrate-pi:${APPSTRATE_VERSION:-1.0.0-beta.53}`, capturing the whole
    // `${…}` expression. Harmless while non-parsing matches were dropped;
    // 84 false findings the moment they are reported.
    const scan = findVersionSites(
      "    image: ghcr.io/appstrate/appstrate-pi:${APPSTRATE_VERSION:-1.0.0-beta.53}\n",
    );
    expect(scan.sites).toHaveLength(1);
    expect(scan.malformed).toHaveLength(0);
  });

  it("reads an alias out of a backtick-quoted prose mention", () => {
    // `docker-compose.yml`'s header says `ghcr.io/appstrate/appstrate:latest`
    // inside markdown backticks; a capture that swallowed the closing backtick
    // read `latest\`` and missed the alias family by one character.
    const scan = findVersionSites("# so `ghcr.io/appstrate/appstrate:latest` does not exist\n");
    expect(scan.malformed).toHaveLength(0);
    expect(scan.skipped).toBe(1);
  });
});

// Every case here injects the tag list. These tests USED to call the real `git
// tag --list` through `resolveReleaseSource({})`, which made them assert on
// whatever the checkout happened to carry: green on a developer's full clone,
// red in `.github/workflows/test.yml`'s `Unit tests` job, whose
// `actions/checkout` has no `fetch-tags` and therefore no tags at all. Adding
// `fetch-tags` to that workflow would have fixed the symptom and left a unit
// test that still breaks in the next shallow clone, container or fresh
// worktree. The ambient read is the defect; injection removes it.
describe("resolveReleaseSource", () => {
  /** A checkout carrying tags — deliberately unordered-looking, see below. */
  const tags = ["v1.2.3", "v1.2.2", "v1.0.0-beta.53"];
  /** A checkout with no `v*` tags: shallow clone, CI default, fresh worktree. */
  const noTags: string[] = [];

  it("takes the tag being released, EXACTLY, on a tag push", () => {
    // Same value release.yml feeds the Dockerfile as APP_VERSION.
    const source = resolveReleaseSource(
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v1.2.3" },
      () => noTags,
    );
    expect(source).toMatchObject({ version: "1.2.3", mode: "exact" });
  });

  it("prefers the release ref over the tag list — the ref is the release identity", () => {
    // Control for the case above: with tags present AND a tag ref, the ref
    // still wins. Without this half, "exact" could be an artefact of the empty
    // list rather than of the ref being read at all.
    const source = resolveReleaseSource(
      { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.9.0" },
      () => tags,
    );
    expect(source).toMatchObject({ version: "0.9.0", mode: "exact" });
  });

  it("ignores a BRANCH ref — a PR run is not a release", () => {
    // `GITHUB_REF_NAME` is populated on every run; only `GITHUB_REF_TYPE=tag`
    // makes it a release identity. Reading the name alone would make a branch
    // called `v2` a release, and would make `1234/merge` unparseable noise.
    const source = resolveReleaseSource(
      { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "1234/merge" },
      () => tags,
    );
    expect(source).toMatchObject({ version: "1.2.3", mode: "floor" });
  });

  it("ignores a branch NAMED like a tag", () => {
    const source = resolveReleaseSource(
      { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v9.9.9" },
      () => tags,
    );
    expect(source).toMatchObject({ version: "1.2.3", mode: "floor" });
  });

  it("falls back to the newest repo tag, as a FLOOR", () => {
    const source = resolveReleaseSource({}, () => tags);
    expect(source).toMatchObject({ version: "1.2.3", mode: "floor" });
    expect(source.origin).toContain("newest git tag v1.2.3");
  });

  it("takes the FIRST semver-parseable tag, skipping ones that sort anywhere", () => {
    // The list arrives in git's `-v:refname` order, so position 0 is already
    // the newest — but a non-semver tag has no defined position in that order
    // and must not become the floor by being first.
    const source = resolveReleaseSource({}, () => ["v-nightly", "vNEXT", ...tags]);
    expect(source).toMatchObject({ version: "1.2.3", mode: "floor" });
  });

  it("THROWS when there is neither a release ref nor a tag, naming the fix", () => {
    // The gate refuses to degrade to "consistency only" — see the module
    // header. This is the arm the `Unit tests` job was hitting by accident.
    expect(() => resolveReleaseSource({}, () => noTags)).toThrow(/no `v\*` tag and no release ref/);
    expect(() => resolveReleaseSource({}, () => noTags)).toThrow(/fetch-tags/);
  });
});

// The one place the real ambient read is exercised. It asserts only what holds
// in EVERY checkout — including one with zero tags, which is the state that
// broke the suite — so it can verify that `git tag --list` runs and that its
// output is parsed into the shape `resolveReleaseSource` consumes, without
// depending on which tags exist.
describe("gitTags", () => {
  it("reads this checkout's `v*` tags without requiring any to exist", () => {
    const tags = gitTags();
    expect(Array.isArray(tags)).toBe(true);
    for (const tag of tags) {
      expect(tag).toMatch(/^v\S+$/);
    }
    // No blank entries: the trailing newline of `git tag --list` is dropped,
    // which is what would otherwise make an empty repo look like it has one
    // tag named "".
    expect(tags).not.toContain("");
  });

  it("is accepted by resolveReleaseSource as its default source", () => {
    // Composes the real lister with the resolver WITHOUT asserting a version:
    // with tags it yields a floor, without them it throws the actionable
    // error. Both are correct, and asserting either one specifically is what
    // made the suite depend on the checkout.
    const attempt = (): ReleaseSource | "no source" => {
      try {
        return resolveReleaseSource({}, gitTags);
      } catch {
        return "no source";
      }
    };
    const result = attempt();
    if (result === "no source") {
      expect(gitTags()).toHaveLength(0);
    } else {
      expect(result.mode).toBe("floor");
      expect(gitTags().length).toBeGreaterThan(0);
    }
  });
});

/**
 * The verdict itself, as the gate computes it.
 *
 * `main()` reads tracked files and prints, so it is not the unit under test —
 * these hold the RULE that `main()` applies. The floor arm's asymmetry is the
 * load-bearing part: behind is rejected, ahead is accepted, and a test that
 * only asserted the first would happily pass against an equality check that
 * deadlocks every release-bump PR.
 */
describe("isStale", () => {
  const src = (version: string, mode: ReleaseSource["mode"]): ReleaseSource => ({
    version,
    mode,
    origin: "test",
  });

  /** The version as the gate would read it out of a real compose line. */
  const asShipped = (version: string): string => sitesOf(compose(version))[0]!.version;

  it("rejects a fallback BEHIND the newest release", () => {
    expect(isStale(asShipped("1.0.0-beta.41"), src("1.0.0-beta.53", "floor"))).toBe(true);
  });

  it("accepts a fallback EQUAL to the newest release", () => {
    expect(isStale(asShipped("1.0.0-beta.53"), src("1.0.0-beta.53", "floor"))).toBe(false);
  });

  it("accepts a fallback AHEAD of the newest release — the bump PR", () => {
    // The release order is bump → merge → tag, so the PR that fixes staleness
    // is necessarily one release ahead of every tag that exists. An equality
    // check here would fail exactly that PR, which is the deadlock shape
    // PR #1032 had to unwind for the core lockstep gate.
    expect(isStale(asShipped("1.0.0-beta.54"), src("1.0.0-beta.53", "floor"))).toBe(false);
  });

  it("orders prereleases numerically, not lexically", () => {
    // `beta.9` vs `beta.53`: a string compare puts `9` on top and would call a
    // beta.9 fallback current at beta.53.
    expect(isStale(asShipped("1.0.0-beta.9"), src("1.0.0-beta.53", "floor"))).toBe(true);
    expect(isStale(asShipped("1.0.0-beta.53"), src("1.0.0-beta.9", "floor"))).toBe(false);
  });

  it("demands EQUALITY on a tag push, in both directions", () => {
    // Ahead is fine for the floor and wrong for a release: the images being
    // built at that tag are the ones the compose file must name.
    expect(isStale(asShipped("1.0.0-beta.54"), src("1.0.0-beta.53", "exact"))).toBe(true);
    expect(isStale(asShipped("1.0.0-beta.52"), src("1.0.0-beta.53", "exact"))).toBe(true);
    expect(isStale(asShipped("1.0.0-beta.53"), src("1.0.0-beta.53", "exact"))).toBe(false);
  });
});

/**
 * The parse half of the ambient read, driven directly.
 *
 * `gitTags` composes a spawn with this; the spawn is exercised by the `gitTags`
 * block above. The branch worth its own case is the non-zero exit: it ENDS the
 * gate, and reaching it through the real command would mean running `git`
 * somewhere that is not a repository — a fact about the runner's temp
 * directory, not about this code.
 */
describe("parseGitTags", () => {
  it("THROWS on a non-zero exit, carrying git's own stderr", () => {
    // Mutation caught: deleting the `if (exitCode !== 0) throw` returns `[]`,
    // which `resolveReleaseSource` reads as "no tags" — a gate that could not
    // look, reporting that it looked and found nothing.
    expect(() => parseGitTags(128, "", "fatal: not a git repository\n")).toThrow(
      /git tag --list failed \(exit 128\)/,
    );
    expect(() => parseGitTags(128, "", "fatal: not a git repository\n")).toThrow(
      /not a git repository/,
    );
  });

  it("returns an EMPTY list on a clean exit with no output — the other half", () => {
    // "Looked, found nothing" is a legitimate state `resolveReleaseSource`
    // turns into its actionable throw. Conflating it with the case above is
    // what makes a broken checkout look like an untagged one.
    expect(parseGitTags(0, "", "")).toEqual([]);
    expect(parseGitTags(0, "\n\n", "")).toEqual([]);
  });

  it("trims and drops the trailing newline git always emits", () => {
    expect(parseGitTags(0, "v1.2.3\nv1.2.2\n", "")).toEqual(["v1.2.3", "v1.2.2"]);
  });
});

/**
 * `main()`'s decisions, every branch of them.
 *
 * All four of these END THE GATE, and none was reachable from a test before:
 * `main` was not exported and read `trackedFiles` + `readFileSync` +
 * `process.env` directly, so deleting the vacuity floor or the disagreement
 * branch left the suite green. Each case below names the mutation it catches.
 */
describe("main", () => {
  const source = (version: string, mode: ReleaseSource["mode"] = "floor"): ReleaseSource => ({
    version,
    mode,
    origin: `test source ${version}`,
  });

  /** Runs `main` over synthetic files, capturing what it printed. */
  const run = (
    contents: Record<string, string>,
    resolveSource: () => ReleaseSource = () => source("1.0.0-beta.53"),
  ): { code: number; out: string; err: string } => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main({
      files: Object.keys(contents),
      readFile: (f) => contents[f]!,
      resolveSource,
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("passes when every site names the source version", () => {
    const r = run({ "docker-compose.yml": compose("1.0.0-beta.53") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 hardcoded version site(s)");
    expect(r.out).toContain("0 unparseable");
  });

  it("FAILS on the vacuity floor — files matched, zero version sites", () => {
    // Mutation caught: deleting the `sites.length === 0` branch. Without it
    // `distinct[0]` is `undefined`, `isStale(undefined, …)` is falsy-ish and
    // the gate prints "0 hardcoded version site(s) … all name undefined" at
    // exit 0. This is the branch that fires when `${APPSTRATE_VERSION:-…}`
    // changes shape and the gate quietly stops looking.
    const r = run({ "docker-compose.yml": "services:\n  appstrate:\n    image: postgres:16\n" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("pass vacuously");
  });

  it("accepts a file with sites alongside one with none — the other half", () => {
    // The floor is about the TOTAL being zero, not about every file
    // contributing. `test/setup/docker-compose.test.yml` legitimately has no
    // version site; a per-file floor would fail the repo as it stands.
    const r = run({
      "docker-compose.yml": compose("1.0.0-beta.53"),
      "test/setup/docker-compose.test.yml": "services:\n  db:\n    image: postgres:16\n",
    });
    expect(r.code).toBe(0);
  });

  it("FAILS on a malformed site even when every other site agrees", () => {
    // Mutation caught: deleting the `malformed.length > 0` branch restores the
    // measured defect — 81 sites agree, the 82nd names a tag GHCR does not
    // have, and the gate exits 0.
    const r = run({
      "docker-compose.yml": compose("1.0.0-beta.53"),
      "examples/self-hosting/docker-compose.yml": compose("1.0.0.beta.53"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("examples/self-hosting/docker-compose.yml");
    expect(r.err).toContain("1.0.0.beta.53");
  });

  it("FAILS when the shipped files disagree, naming the odd ones out", () => {
    // Mutation caught: deleting the `distinct.length > 1` branch. `distinct[0]`
    // is then the HIGHEST version (the list is sorted descending), so a repo
    // where one file was bumped and four were not passes on the strength of the
    // one that was.
    const r = run({
      "docker-compose.yml": compose("1.0.0-beta.53"),
      "examples/self-hosting/docker-compose.yml": compose("1.0.0-beta.41"),
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("disagree about the release version");
    expect(r.err).toContain("examples/self-hosting/docker-compose.yml");
    expect(r.err).toContain("1.0.0-beta.41");
  });

  it("FAILS when every site agrees on a version BEHIND the source", () => {
    const r = run({ "docker-compose.yml": compose("1.0.0-beta.41") }, () =>
      source("1.0.0-beta.53"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("is BEHIND the newest release");
  });

  it("PASSES on a version ahead of the floor, and says so", () => {
    // The bump PR. An equality check here would fail exactly the change that
    // fixes staleness — the PR #1032 deadlock shape.
    const r = run({ "docker-compose.yml": compose("1.0.0-beta.54") }, () =>
      source("1.0.0-beta.53"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("a release bump in flight");
  });

  it("FAILS the same 'ahead' input under the EXACT arm", () => {
    // The arm `release.yml`'s preflight job takes. Same files, same tag, other
    // verdict: at a tag push the images carry that tag and nothing else.
    const r = run({ "docker-compose.yml": compose("1.0.0-beta.54") }, () =>
      source("1.0.0-beta.53", "exact"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("must EQUAL the tag being released");
  });

  it("PASSES under the EXACT arm when the sites name the tag being released", () => {
    const r = run({ "docker-compose.yml": compose("1.0.0-beta.53") }, () =>
      source("1.0.0-beta.53", "exact"),
    );
    expect(r.code).toBe(0);
  });

  it("does not resolve the source at all when the vacuity floor fires", () => {
    // Ordering, asserted: the floor is about this checkout's files and must not
    // depend on a tag lookup that can itself throw. A source resolution before
    // the floor turns "the pattern changed shape" into "no `v*` tag".
    let resolved = 0;
    const code = main({
      files: ["docker-compose.yml"],
      readFile: () => "services: {}\n",
      resolveSource: () => {
        resolved += 1;
        return source("1.0.0-beta.53");
      },
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(1);
    expect(resolved).toBe(0);
  });
});
