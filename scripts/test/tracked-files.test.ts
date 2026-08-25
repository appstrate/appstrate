// SPDX-License-Identifier: Apache-2.0

/**
 * The one property every gate built on `git ls-files` depends on and none of
 * them could state on its own: **an empty match is a failure, not a pass**.
 *
 * Three gates — `scripts/lint.ts`, `scripts/lint-manifest-casing.ts`,
 * `scripts/verify-compose-defaults.ts` — each carried their own copy of the
 * spawn, the exit-code check, the NUL split and the vacuity throw. Every one of
 * them turns its file list into a `for` loop whose body is the whole gate, so a
 * copy that lost the throw would report a clean run over zero files, in the
 * cheerful past tense, for as long as nobody looked. One implementation, and
 * the assertions below hold it.
 */

import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_GLOBS, SOURCE_GLOBS, trackedFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("trackedFiles", () => {
  it("throws instead of returning an empty list", () => {
    // The failure mode this module exists for. A gate handed `[]` iterates
    // nothing, finds nothing, and prints its success line.
    expect(() => trackedFiles(["*.zz-no-such-extension"], "widget")).toThrow(
      /matched no widget — the gate would pass vacuously/,
    );
  });

  it("names the population in the vacuity error", () => {
    // Three gates share this throw, so the message has to say which one is
    // suddenly looking at nothing.
    expect(() => trackedFiles(["*.zz-no-such-extension"], "compose file")).toThrow(
      /matched no compose file/,
    );
  });

  it("returns tracked source files, sorted", () => {
    const files = trackedFiles(SOURCE_GLOBS, "source file");
    expect(files.length).toBeGreaterThan(1000);
    expect(files).toEqual([...files].sort());
    // Anchors rather than a count, so this does not fail on every file added.
    // All three are long-lived tracked paths — a file this branch adds is not
    // in the INDEX until it is committed, and would make this test red until
    // then for a reason that has nothing to do with the property.
    expect(files).toContain("scripts/lint.ts");
    expect(files).toContain("scripts/lib/policy-env.ts");
    expect(files).toContain("eslint.config.mjs");
  });

  it("covers every extension the lint scope claims", () => {
    // `SOURCE_GLOBS` is restated in `turbo.json`'s `//#lint` inputs (turbo
    // reads JSON, not TypeScript). Pinning the list here means the copy has
    // something to be checked against.
    expect([...SOURCE_GLOBS]).toEqual(["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"]);
  });

  it("returns only paths that exist on disk", () => {
    // The index can name a file already removed from the working tree (a
    // `git rm` not yet committed). Callers read these paths directly, so the
    // filter is the module's contract, not an optimisation — it is the reason
    // `lint-manifest-casing.ts` no longer needs its own ENOENT catch.
    const missing = trackedFiles(SOURCE_GLOBS, "source file").filter(
      (rel) => !existsSync(join(REPO_ROOT, rel)),
    );
    expect(missing).toEqual([]);
  });

  it("finds the compose files the drift gate scans", () => {
    const files = trackedFiles(COMPOSE_GLOBS, "compose file");
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /docker-compose.*\.ya?ml$/.test(f))).toBe(true);
    expect(files).toContain("docker-compose.yml");
  });
});
