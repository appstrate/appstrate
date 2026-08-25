// SPDX-License-Identifier: Apache-2.0

/**
 * `bun run lint` must not be able to report success over files ESLint never
 * had a rule for.
 *
 * The version of `scripts/lint.ts` these tests were written against passed
 * `--no-warn-ignored`, to silence one warning line about the generated
 * `apps/web/src/api/schema.d.ts`. That flag does not silence one path, it
 * silences the mechanism — the ONLY signal a caller gets that the config has
 * un-scoped something. Measured 2026-08-25 by adding `"apps/**"` to the
 * `ignores` array in `eslint.config.mjs`: `bun scripts/lint.ts` handed eslint
 * 2204 paths, got an empty result for ~2100 of them, printed ZERO bytes and
 * exited 0. `bun run check` was green over an unlinted API and SPA.
 *
 * So the ignored set is asserted rather than muted, and both directions of
 * drift are held below: a widened `ignores`, and a stale entry that has stopped
 * excluding anything (the `deadExclusions` rule the sibling gate
 * `scripts/lint-manifest-casing.ts` already applies to its own exclusions).
 */

import { describe, it, expect } from "bun:test";
import { ESLint } from "eslint";
import { join } from "node:path";
import { assertIgnoredSetIsExact, KNOWN_IGNORED, partitionIgnored } from "../lint.ts";
import { SOURCE_GLOBS, trackedFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("assertIgnoredSetIsExact", () => {
  it("accepts exactly the documented set", () => {
    expect(() => assertIgnoredSetIsExact([...KNOWN_IGNORED])).not.toThrow();
  });

  it("throws when `ignores` swallows files nobody documented", () => {
    // The `"apps/**"` mutation, in miniature: files eslint reports NOTHING
    // about, which under the old flag produced no output and exit 0.
    expect(() =>
      assertIgnoredSetIsExact([...KNOWN_IGNORED, "apps/api/src/index.ts", "apps/web/src/main.tsx"]),
    ).toThrow(/2 tracked file\(s\) are excluded by `ignores`/);
  });

  it("throws when a documented entry has stopped excluding anything", () => {
    // The other direction, and the one a stale list hides: an entry that
    // matches nothing today silently excuses whatever lands at that path next.
    expect(() => assertIgnoredSetIsExact([])).toThrow(/no longer match an ignored tracked file/);
  });
});

describe("partitionIgnored", () => {
  const files = ["a.ts", "b.ts", "c.ts"];

  it("keeps the ignored files out of the list handed to eslint", async () => {
    const { lintable, ignored } = await partitionIgnored(files, (f) => f === "b.ts");
    expect(lintable).toEqual(["a.ts", "c.ts"]);
    expect(ignored).toEqual(["b.ts"]);
  });

  it("surfaces a config that ignores everything as an empty lintable set", async () => {
    const { lintable, ignored } = await partitionIgnored(files, () => true);
    expect(lintable).toEqual([]);
    expect(ignored).toEqual(files);
    // …which the assertion then refuses, rather than eslint being handed
    // nothing and exiting 0.
    expect(() => assertIgnoredSetIsExact(ignored)).toThrow();
  });
});

describe("the live eslint config", () => {
  it("ignores exactly the tracked files KNOWN_IGNORED documents", async () => {
    // The wiring test: the two pure halves above can both be right while the
    // gate reads the wrong config. This one asks the real `eslint.config.mjs`
    // about the real tracked file list.
    const api = new ESLint({ cwd: REPO_ROOT });
    const { ignored } = await partitionIgnored(
      trackedFiles(SOURCE_GLOBS, "lintable file"),
      (file) => api.isPathIgnored(file),
    );
    expect(ignored).toEqual([...KNOWN_IGNORED]);
  });
});
