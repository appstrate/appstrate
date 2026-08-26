// SPDX-License-Identifier: Apache-2.0

/**
 * Drift guard for `@appstrate/core`'s PUBLISHED export surface.
 *
 * This package's CHANGELOG is the only contract its out-of-tree consumers read
 * (`cloud`, `connect-helper`, third-party modules). Nothing checked it, and it
 * drifted: preparing 8.0.0 it removed six exports it never mentioned, added a
 * required member to a published interface without a word, and carried three
 * statements that the code contradicted — including one it contradicted
 * ITSELF, 35 lines apart.
 *
 * knip cannot help here by design: `knip.config.ts` lists every core subpath as
 * an entry, precisely because the readers live out of tree, so an unused core
 * export is never reported. That exemption is correct and this test is its
 * counterweight — the surface is unpoliced in one direction, so police it in
 * the other.
 *
 * ## The baseline
 *
 * `published-export-baseline.json` is the export set of the version currently
 * ON NPM, unpacked from the tarball — not from the workspace, and not from a
 * git tag. `cloud/node_modules/@appstrate/core` is a symlink into this
 * monorepo, so a green local typecheck says nothing about what consumers can
 * actually resolve; the tarball is the only source that does.
 *
 * REGENERATE IT AS THE LAST STEP OF A RELEASE, after `core@X.Y.Z` is published:
 *
 *     cd $(mktemp -d) && npm pack @appstrate/core@X.Y.Z --silent && tar -xzf *.tgz
 *     bun -e 'const {exportedNames}=await import("<repo>/packages/core/test/helpers/export-surface.ts");
 *       const n=await exportedNames("package/src");
 *       await Bun.write("<repo>/packages/core/test/published-export-baseline.json",
 *         JSON.stringify({version:"X.Y.Z",exports:Object.keys(n).sort()},null,2)+"\n")'
 *
 * Between releases the baseline stays put and this test measures the whole
 * unreleased delta, which is exactly what the `[Unreleased]` section must
 * describe.
 *
 * ## Both directions of that delta
 *
 * `baseline \ current` is a REMOVAL — the thing that breaks a consumer at
 * upgrade time, and the obvious half to guard. `current \ baseline` is an
 * ADDITION, and it is guarded here for a less obvious reason: publishing a name
 * is a semver commitment. From the moment it reaches npm, removing or renaming
 * it is a major, and consumers may already be importing it. An addition nobody
 * wrote down is therefore a promise nobody decided to make — which is how ten
 * of them shipped in `8.0.0`, including `CONTEXT_FREE_FILENAMES_PHRASE`.
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exportedNames } from "./helpers/export-surface.ts";

const PKG = join(import.meta.dir, "..");

/** The `[Unreleased]` section of the CHANGELOG, or "" when there is none. */
async function unreleasedSection(): Promise<string> {
  const changelog = await readFile(join(PKG, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf("[Unreleased]");
  if (start === -1) return "";
  const rest = changelog.slice(start);
  const next = rest.slice(1).search(/\n## \[/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("@appstrate/core published export surface", () => {
  it("names every removed export in the CHANGELOG's [Unreleased] section", async () => {
    const baseline = JSON.parse(
      await readFile(join(PKG, "test/published-export-baseline.json"), "utf8"),
    ) as { version: string; exports: string[] };
    const current = await exportedNames(join(PKG, "src"));
    const unreleased = await unreleasedSection();

    // Positive controls: neither side may be empty, or this passes vacuously.
    expect(baseline.exports.length).toBeGreaterThan(100);
    expect(Object.keys(current).length).toBeGreaterThan(100);

    const removed = baseline.exports.filter((name) => !(name in current));
    const undocumented = removed.filter((name) => !unreleased.includes(name));

    expect(
      undocumented,
      `These exports exist in the published ${baseline.version} and are gone at HEAD, ` +
        `but the CHANGELOG's [Unreleased] section never names them. Out-of-tree ` +
        `consumers read that section to find out what broke.\n` +
        `  ${undocumented.join("\n  ")}\n\n` +
        `A rename counts as documented when the entry names the OLD symbol too.`,
    ).toEqual([]);
  });

  it("names every added export in the CHANGELOG's [Unreleased] section", async () => {
    const baseline = JSON.parse(
      await readFile(join(PKG, "test/published-export-baseline.json"), "utf8"),
    ) as { version: string; exports: string[] };
    const current = await exportedNames(join(PKG, "src"));
    const unreleased = await unreleasedSection();

    // Same positive controls as the removals case, and for the same reason.
    expect(baseline.exports.length).toBeGreaterThan(100);
    expect(Object.keys(current).length).toBeGreaterThan(100);

    // Computed through the SAME `exportedNames` helper the baseline was built
    // with, so "export" means one thing in both sets and the difference is a
    // real delta rather than two definitions disagreeing.
    const published = new Set(baseline.exports);
    const added = Object.keys(current).filter((name) => !published.has(name));
    const undocumented = added.filter((name) => !unreleased.includes(name)).sort();

    expect(
      undocumented,
      `These exports are new since the published ${baseline.version}, but the ` +
        `CHANGELOG's [Unreleased] section never names them. Publishing a name is a ` +
        `semver commitment: once it is on npm, taking it back is a major.\n` +
        `  ${undocumented.join("\n  ")}\n\n` +
        `Naming it anywhere in the section counts — a bullet of its own is not required ` +
        `when it belongs to a module the section already describes.`,
    ).toEqual([]);
  });

  it("does not claim to have removed something that is still exported", async () => {
    const current = await exportedNames(join(PKG, "src"));
    const unreleased = await unreleasedSection();

    // Only the Removed subsection — an Added/Changed entry legitimately names
    // symbols that still exist.
    const removedHeading = unreleased.indexOf("### Removed");
    const removedBlock =
      removedHeading === -1 ? "" : (unreleased.slice(removedHeading).split(/\n### /)[0] ?? "");

    // Bolded leading symbol of each bullet: `- **\`name\`** (…)` or
    // `- **\`a\`, \`b\`** (…)`.
    const claimed = new Set<string>();
    for (const m of removedBlock.matchAll(/^- \*\*((?:`[^`]+`(?:,\s*)?)+)\*\*/gm)) {
      for (const sym of (m[1] ?? "").matchAll(/`([^`]+)`/g)) {
        const name = (sym[1] ?? "").trim();
        // Skip subpaths, member paths and prose — bare identifiers only.
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) claimed.add(name);
      }
    }

    // The canary only says something when there IS a Removed section. Right
    // after a release the unreleased window legitimately removes nothing, and
    // an empty window is not the same failure as a regex that stopped matching.
    if (removedHeading !== -1) {
      expect(claimed.size, "no Removed entries parsed — the bullet shape changed").toBeGreaterThan(
        0,
      );
    }

    const stillThere = [...claimed].filter((name) => name in current).sort();
    expect(
      stillThere,
      `The CHANGELOG lists these under Removed, but they are still exported from ` +
        `src. Either the removal did not land or the entry is wrong:\n  ` +
        stillThere.join("\n  "),
    ).toEqual([]);
  });
});
