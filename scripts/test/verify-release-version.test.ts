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
  isStale,
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

describe("findVersionSites", () => {
  it("finds every `${APPSTRATE_VERSION:-…}` fallback, with its line", () => {
    const sites = findVersionSites(compose("1.0.0-beta.53"));
    expect(sites.map((s) => s.version)).toEqual(["1.0.0-beta.53", "1.0.0-beta.53"]);
    expect(sites.map((s) => s.line)).toEqual([3, 5]);
  });

  it("finds a commented `APPSTRATE_VERSION=` assignment in an .env.example", () => {
    const sites = findVersionSites("# APPSTRATE_VERSION=1.0.0-beta.53\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.version).toBe("1.0.0-beta.53");
  });

  it("finds a LITERAL image pin — the third value in the measured drift", () => {
    // `.env.example` carried `beta.51` example pins while every compose file
    // said `beta.41`. A gate that read only the interpolated fallbacks would
    // have called that repo clean.
    const sites = findVersionSites("# PI_IMAGE=ghcr.io/appstrate/appstrate-pi:1.0.0-beta.51\n");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.version).toBe("1.0.0-beta.51");
  });

  it("strips a leading `v` so a tag-shaped value compares equal to a bare one", () => {
    expect(findVersionSites(compose("v1.0.0-beta.53"))[0]!.version).toBe("1.0.0-beta.53");
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
    expect(findVersionSites(content)).toHaveLength(0);
  });

  it("does not fire on an unrelated registry", () => {
    expect(findVersionSites("    image: docker.io/library/postgres:16.4\n")).toHaveLength(0);
  });
});

describe("resolveReleaseSource", () => {
  it("takes the tag being released, EXACTLY, on a tag push", () => {
    // Same value release.yml feeds the Dockerfile as APP_VERSION.
    const source = resolveReleaseSource({
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.2.3",
    });
    expect(source).toMatchObject({ version: "1.2.3", mode: "exact" });
  });

  it("ignores a BRANCH ref — a PR run is not a release", () => {
    // `GITHUB_REF_NAME` is populated on every run; only `GITHUB_REF_TYPE=tag`
    // makes it a release identity. Reading the name alone would make a branch
    // called `v2` a release, and would make `1234/merge` unparseable noise.
    const source = resolveReleaseSource({
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "1234/merge",
    });
    expect(source.mode).toBe("floor");
  });

  it("falls back to the newest repo tag, as a FLOOR", () => {
    const source = resolveReleaseSource({});
    expect(source.mode).toBe("floor");
    expect(source.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(source.origin).toContain("newest git tag");
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
  const asShipped = (version: string): string => findVersionSites(compose(version))[0]!.version;

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
