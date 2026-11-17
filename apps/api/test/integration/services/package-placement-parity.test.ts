// SPDX-License-Identifier: Apache-2.0

/**
 * ONE definition of "PLACED here", stated FOUR times — and the four must agree.
 *
 * Activation is stated twice and has `package-activation-parity.test.ts` to
 * hold the pair together. Placement has twice as many statements, each written
 * in a different dialect for a different caller, and nothing but reading all
 * four keeps them honest:
 *
 *   - `placementReadFilter(spaceId)` — the SQL filter (`package-placement.ts`),
 *     conjoined into every listing;
 *   - `placementGrantsRead(pkg, placedIn, readable)` — the in-memory form
 *     (`lib/package-access.ts`), for callers holding rows and a set of spaces;
 *   - `isPackageReadableInSpace(spaceId, packageId)` — the standalone query
 *     behind `requireAgent()` and the execution verdict;
 *   - the TRANSACTIONAL reading inside `activatePackageWithin`, which decides
 *     under a row lock whether an activation may proceed without placing the
 *     package. It is exercised through the door it guards: `activatePackage`
 *     with no `placeAs` refuses exactly the packages that are not placed.
 *
 * The table is every cell of the rule: two provenances × the home here or
 * elsewhere × a `space_packages` row present or absent. One cell sits outside
 * it because it needs a SECOND space to state — a row in another space — and
 * it is the negative the rule is most easily widened into.
 *
 * ONE asymmetry is pinned rather than smoothed over. `placementGrantsRead`
 * carries NO system term — its callers add it (`assertPackageIsReachable`,
 * `isPackageReadableInSpace`), because they are the ones holding the `source`
 * column. So the parity assertion for that form is `system ∨ grantsRead(…)`,
 * and a future edit that moves the system term INTO the function, or drops it
 * from a caller, breaks this test rather than one tenant's visibility.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { packages, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { grepFiles, REPO_ROOT } from "../../helpers/source-grep.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare, seedSpace } from "../../helpers/seed.ts";
import { placementReadFilter, placementRowJoin } from "../../../src/services/package-placement.ts";
import { isPackageReadableInSpace, placementGrantsRead } from "../../../src/lib/package-access.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";

getTestApp();

let ctx: TestContext;
/** The HOME of the packages the space under test does not home. */
let elsewhere: string;

const SOURCES = ["local", "system"] as const;
const HOMES = [
  { label: "homed here", here: true },
  { label: "homed elsewhere", here: false },
] as const;
const ROWS = [
  { label: "a row here", row: true },
  { label: "no row", row: false },
] as const;

/**
 * The SQL form, asked about ONE package in ONE space — with the
 * `spacePackages` LEFT JOIN the filter documents.
 */
async function sqlSaysPlaced(spaceId: string, packageId: string): Promise<boolean> {
  const [hit] = await db
    .select({ placed: sql<boolean>`${placementReadFilter(spaceId)}` })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  return hit!.placed;
}

/**
 * The transactional form, read through the door it guards. `activatePackage`
 * with no `placeAs` switches the package on when it is placed and throws a 404
 * when it is not — so "did it throw" IS that predicate's answer.
 */
async function doorSaysPlaced(spaceId: string, packageId: string): Promise<boolean> {
  try {
    await activatePackage({ orgId: ctx.orgId, spaceId }, packageId);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  elsewhere = (await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" })).id;
});

describe("the four statements of PLACED answer the same, cell for cell", () => {
  for (const source of SOURCES) {
    for (const { label: homeLabel, here } of HOMES) {
      for (const { label: rowLabel, row } of ROWS) {
        it(`${source} / ${homeLabel} / ${rowLabel}`, async () => {
          const id = `@placement/${source}`;
          const system = source === "system";
          const homeSpaceId = system ? null : here ? ctx.defaultSpaceId : elsewhere;
          await seedPackage({
            id,
            orgId: system ? null : ctx.orgId,
            type: "agent",
            source,
            homeSpaceId,
            draftManifest: { name: id, version: "0.1.0", type: "agent" },
          });
          if (row) await seedPackageShare(ctx.defaultSpaceId, id);

          // The rule itself, spelled out once here so the four forms are
          // compared against the RULE and not merely against each other —
          // four statements agreeing on the same wrong answer is the failure
          // a parity test between them cannot see.
          const expected = system || (here && !system) || row;

          const fromSql = await sqlSaysPlaced(ctx.defaultSpaceId, id);
          const fromQuery = await isPackageReadableInSpace(ctx.defaultSpaceId, id);
          // The system term belongs to the CALLER of this form — see the
          // module docstring above.
          const fromMemory =
            system ||
            placementGrantsRead(
              { homeSpaceId },
              row ? [ctx.defaultSpaceId] : [],
              new Set([ctx.defaultSpaceId]),
            );
          const fromDoor = await doorSaysPlaced(ctx.defaultSpaceId, id);

          expect({ fromSql, fromQuery, fromMemory, fromDoor }).toEqual({
            fromSql: expected,
            fromQuery: expected,
            fromMemory: expected,
            fromDoor: expected,
          });
        });
      }
    }
  }

  it("does NOT count a row held by ANOTHER space, in any of the four", async () => {
    // The space narrowing of `placementRowJoin`, asked as a cell. The table
    // above seeds every row in the space under test, so all four forms answer
    // it the same whether the join reads `(package, THIS space)` or `(package)`
    // alone — and the second is the silent widening the join's docstring warns
    // about, the one that turns "placed here" into "placed anywhere".
    const id = "@placement/placed-elsewhere";
    const third = (await seedSpace({ orgId: ctx.orgId, name: "Third" })).id;
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: elsewhere,
      draftManifest: { name: id, version: "0.1.0", type: "agent" },
    });
    await seedPackageShare(third, id);

    expect({
      fromSql: await sqlSaysPlaced(ctx.defaultSpaceId, id),
      fromQuery: await isPackageReadableInSpace(ctx.defaultSpaceId, id),
      fromMemory: placementGrantsRead(
        { homeSpaceId: elsewhere },
        [third],
        new Set([ctx.defaultSpaceId]),
      ),
      fromDoor: await doorSaysPlaced(ctx.defaultSpaceId, id),
    }).toEqual({
      fromSql: false,
      fromQuery: false,
      fromMemory: false,
      fromDoor: false,
    });
  });
});

describe("the joins are owned, not copied", () => {
  /**
   * A placement-aware query carries a LEFT JOIN of `spacePackages` narrowed to
   * (package, THIS space). Omitting the join raises a Postgres `missing
   * FROM-clause entry`, but joining on the PACKAGE ALONE raises nothing: it
   * turns "placed in THIS space" into "placed in any space at all", makes
   * `activeHereSql` read another space's `enabled`, and makes a listing project
   * another space's model and proxy overrides. All silently.
   *
   * `placementRowJoin` takes the space as a required argument, so that mistake
   * has nowhere to live. The test below is what keeps the next reader from
   * re-introducing it by hand: the ON clause belongs to the module that owns
   * the rule, and to nowhere else.
   */
  /**
   * Every hand-written `(package, space)` ON clause on `table`, as `file:line`.
   *
   * It reads the ENCLOSING CALL rather than the matched line, which is the
   * whole difference between this guard and a `grep | filter` over its output:
   * prettier wraps a multi-condition `and(…)` onto its own lines, so a
   * `.where(` three lines up is invisible to a line-oriented filter and three
   * legitimate WHERE clauses read as offenders. Walking back to the nearest
   * `.leftJoin(` / `.innerJoin(` / `.where(` asks the question that actually
   * matters — is this predicate a JOIN's ON clause — and cannot be fooled by
   * where the formatter put the newline.
   */
  function handWrittenOnClauses(table: string, owners: string[]): string[] {
    const needle = `eq(${table}.packageId`;
    const enclosing = /\.(leftJoin|innerJoin|rightJoin|fullJoin|where|having|on)\(/g;
    // The POSITIVE CONTROL matters more here than anywhere else in the suite:
    // this guard reports its verdict as an EMPTY list, so a search that
    // returned nothing — a needle somebody renamed, a cwd the root suite moved
    // out from under `grep` — reads exactly like "no file writes the clause by
    // hand". `package-placement.ts` owns the rule and must always match, so
    // asking for it turns a silent nothing into a failure.
    const files = grepFiles(needle, ["apps/api/src"], {
      expectMatch: ["apps/api/src/services/package-placement.ts"],
    }).filter((file) => !owners.includes(file));

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(resolve(REPO_ROOT, file), "utf8");
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
        const before = text.slice(0, at);
        enclosing.lastIndex = 0;
        let call: string | null = null;
        for (let m = enclosing.exec(before); m !== null; m = enclosing.exec(before)) call = m[1]!;
        if (call === null || call === "where" || call === "having") continue;
        offenders.push(`${file}:${before.split("\n").length}`);
      }
    }
    return offenders;
  }

  it("no source file writes the `spacePackages` ON clause itself", () => {
    // Two owners beyond the module, and each writes a DIFFERENT shape rather
    // than a copy of this one:
    //   - `space-packages.ts` is the table's own service — the writers and the
    //     transactional reads address one row by its (space, package) key, not
    //     by a join;
    //   - `package-library.ts` joins the SAME table across EVERY space the
    //     caller reads (`inArray(spaceId, accessibleIds)`), because the library
    //     is the one page that answers for more than one space at a time. A
    //     single-space narrowing there would empty the map it exists to draw.
    expect(
      handWrittenOnClauses("spacePackages", [
        "apps/api/src/services/package-placement.ts",
        "apps/api/src/services/space-packages.ts",
        "apps/api/src/services/package-library.ts",
      ]),
    ).toEqual([]);
  });
});
