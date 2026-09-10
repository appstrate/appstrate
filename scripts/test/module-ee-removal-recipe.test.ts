// SPDX-License-Identifier: Apache-2.0

/**
 * `packages/module-ee/` is the one source-available directory in an otherwise
 * Apache-2.0 tree, and its README documents removing it from a redistribution.
 * That recipe is the only artifact in the repo that states which Apache-2.0
 * files are coupled to the commercial one — and prose rots the moment someone
 * adds a coupling, silently, with every gate green: the module is opt-in at
 * RUNTIME (`MODULES`), so a new build-time reference to it costs nothing until
 * a redistributor actually deletes the directory and discovers the list was
 * short. That is exactly what happened: the recipe named four files and the
 * real removal touched roughly forty.
 *
 * So the list is derived from the code rather than trusted. Two mechanical
 * sets, both cheap and both false-positive-free over the current tree:
 *
 *   1. the SPA files that name the commercial WIRE CONTRACT — an `/api/billing`
 *      path or an `Ee*` schema identifier. This is the coupling the recipe
 *      missed, and the one a new billing screen recreates;
 *   2. every tracked `.ts`/`.tsx`/`.json` file outside the module that carries a
 *      quoted `packages/module-ee` PATH — the gate scripts that scan the
 *      directory (one of them exits `ENOENT` without it) and the gate
 *      self-tests that assert it is present.
 *
 * Each derived path must appear verbatim in the recipe. The section says more
 * than the sets derive — i18n keys, the SPA files that reach the module through
 * a helper, the dead `@appstrate/emails` re-exports — because no cheap grep
 * finds those; this gate is the floor under the recipe, not its ceiling. It
 * deliberately does not check what the section SAYS about a file: naming it is
 * what forces an author to look.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackedIndexFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RECIPE_FILE = "packages/module-ee/README.md";
const RECIPE_HEADING = "### Removing the module from a redistribution";

/** An `/api/billing` route, or an `Ee*` schema identifier from the registry. */
const WIRE_CONTRACT = /\/api\/billing|\bEe[A-Z][A-Za-z]*\b/;

/** A `packages/module-ee` path written as a string literal, not as prose. */
const MODULE_PATH_LITERAL = /"packages\/module-ee/;

const read = (file: string): string => readFileSync(join(REPO_ROOT, file), "utf8");

/**
 * The recipe section only: from its heading to the next `## ` heading. Bounded
 * so a path that happens to appear elsewhere in the README — the architecture
 * diagram names plenty — cannot satisfy the gate by accident.
 */
function recipeSection(): string {
  const readme = read(RECIPE_FILE);
  const start = readme.indexOf(RECIPE_HEADING);
  expect(start, `${RECIPE_FILE} no longer contains "${RECIPE_HEADING}"`).toBeGreaterThanOrEqual(0);
  const rest = readme.slice(start + RECIPE_HEADING.length);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Tracked files matching `pattern`, restricted to those under `prefix`. */
function filesMatching(
  globs: readonly string[],
  what: string,
  pattern: RegExp,
  prefix = "",
): string[] {
  return trackedIndexFiles(globs, what)
    .filter((f) => f.startsWith(prefix))
    .filter((f) => pattern.test(read(f)));
}

describe("the module-ee removal recipe names every file coupled to the module", () => {
  const section = recipeSection();

  const spaCoupled = filesMatching(
    ["apps/web/src/*.ts", "apps/web/src/*.tsx"],
    "SPA sources",
    WIRE_CONTRACT,
    "apps/web/src/",
  );

  const pathCoupled = filesMatching(
    ["*.ts", "*.tsx", "*.json"],
    "tracked TS and JSON sources",
    MODULE_PATH_LITERAL,
  ).filter((f) => !f.startsWith("packages/module-ee/"));

  it("derives a non-empty set from each direction", () => {
    // Both sets are read out of the repo, so a broken glob or a moved directory
    // would otherwise let this file pass over nothing and report it as coverage.
    expect(spaCoupled.length).toBeGreaterThan(0);
    expect(pathCoupled.length).toBeGreaterThan(0);
  });

  // `toContain` on the section would print the whole recipe on failure and bury
  // the one path that is missing; the boolean plus a message says it in a line.
  const named = (file: string): void => {
    expect(
      section.includes(file),
      `${RECIPE_FILE} § "${RECIPE_HEADING}" does not name ${file}`,
    ).toBe(true);
  };

  it.each(spaCoupled)("names %s, which reads the commercial wire contract", named);

  it.each(pathCoupled)("names %s, which hardcodes a packages/module-ee path", named);
});
