// SPDX-License-Identifier: Apache-2.0

/**
 * ONE definition of "PLACED here", stated FIVE times — and the five must agree.
 *
 * Activation is stated twice and has `package-activation-parity.test.ts` to
 * hold the pair together. Placement has more than twice as many statements,
 * each written in a different dialect for a different caller, and nothing but
 * reading all five keeps them honest:
 *
 *   - `placementReadFilter(spaceId)` — the SQL filter (`package-placement.ts`),
 *     conjoined into `activeHereSql` and into every listing;
 *   - `placementGrantsRead(pkg, sharedIn, readable)` — the in-memory form
 *     (`lib/package-access.ts`), for callers holding rows and a set of spaces;
 *   - `isPackageReadableInSpace(spaceId, packageId)` — the standalone query
 *     behind `requireAgent()` and the execution verdict;
 *   - `placedRowFilter(tx, spaceId, packageId)` — the `EXISTS` form
 *     (`space-packages.ts`) an UPDATE can carry, drizzle's `update` having no
 *     join to hang the LEFT JOIN on. The one form that guards a WRITE;
 *   - the TRANSACTIONAL reading inside `activatePackageWithin`, which decides
 *     under a row lock whether an activation needs an offer or is refused.
 *
 * The last is module-private on purpose — a lock-taking predicate has no
 * business being called outside the transaction that holds the lock — so it is
 * exercised through the door it guards rather than exported for a test:
 * `activatePackage` with no `shareBy` refuses exactly the packages that are not
 * placed.
 *
 * The table is every cell of the rule: two provenances × the home here or
 * elsewhere × an offer present or absent. Two cells sit outside it because
 * they need a SECOND space to state — an offer made elsewhere, and a
 * `space_packages` row nothing places — and each is the negative the rule is
 * most easily widened into.
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
import { eq, sql } from "drizzle-orm";
import { packages, packageShares } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageShare, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import {
  placementReadFilter,
  placementShareJoin,
} from "../../../src/services/package-placement.ts";
import { isPackageReadableInSpace, placementGrantsRead } from "../../../src/lib/package-access.ts";
import { activatePackage, placedRowFilter } from "../../../src/services/space-packages.ts";

getTestApp();

let ctx: TestContext;
/** The HOME of the packages the space under test does not home. */
let elsewhere: string;

const SOURCES = ["local", "system"] as const;
const HOMES = [
  { label: "homed here", here: true },
  { label: "homed elsewhere", here: false },
] as const;
const OFFERS = [
  { label: "offered here", offered: true },
  { label: "not offered", offered: false },
] as const;

/**
 * The SQL form, asked about ONE package in ONE space — with the
 * `packageShares` LEFT JOIN the filter documents. Omitting it would make every
 * offered package read as unplaced, the exact mistake the docstring warns
 * about, so the probe carries it too.
 */
async function sqlSaysPlaced(spaceId: string, packageId: string): Promise<boolean> {
  const [hit] = await db
    .select({ placed: sql<boolean>`${placementReadFilter(spaceId)}` })
    .from(packages)
    .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  return hit!.placed;
}

/**
 * The UPDATE form: `placedRowFilter` is the same rule as an `EXISTS`
 * sub-select, because drizzle's `update` has no join to hang the LEFT JOIN on.
 * It is the one form that guards a WRITE, so a drift here is a write the rest
 * of the platform refuses to read back.
 */
async function updateFilterSaysPlaced(spaceId: string, packageId: string): Promise<boolean> {
  // Read through the same drizzle SELECT the other forms use rather than
  // `db.execute`: the raw executor hands back a bare array under postgres.js
  // and a `{ rows }` envelope under PGlite, so a hand-unwrapped result would
  // pass on a tier-0 laptop and throw on the tier-3 runner.
  const [hit] = await db
    .select({ placed: sql<boolean>`${placedRowFilter(db, spaceId, packageId)}` })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  return hit!.placed;
}

/**
 * The transactional form, read through the door it guards. `activatePackage`
 * with no `shareBy` writes the placement row when the package is placed and
 * throws a 404 when it is not — so "did it throw" IS that predicate's answer.
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

describe("the five statements of PLACED answer the same, cell for cell", () => {
  for (const source of SOURCES) {
    for (const { label: homeLabel, here } of HOMES) {
      for (const { label: offerLabel, offered } of OFFERS) {
        it(`${source} / ${homeLabel} / ${offerLabel}`, async () => {
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
          if (offered) await seedPackageShare(ctx.defaultSpaceId, id);

          // The rule itself, spelled out once here so the five forms are
          // compared against the RULE and not merely against each other —
          // five statements agreeing on the same wrong answer is the failure
          // a parity test between them cannot see.
          const expected = system || (here && !system) || offered;

          const fromSql = await sqlSaysPlaced(ctx.defaultSpaceId, id);
          const fromQuery = await isPackageReadableInSpace(ctx.defaultSpaceId, id);
          // The system term belongs to the CALLER of this form — see the
          // module docstring above.
          const fromMemory =
            system ||
            placementGrantsRead(
              { homeSpaceId },
              offered ? [ctx.defaultSpaceId] : [],
              new Set([ctx.defaultSpaceId]),
            );
          const fromDoor = await doorSaysPlaced(ctx.defaultSpaceId, id);
          const fromUpdate = await updateFilterSaysPlaced(ctx.defaultSpaceId, id);

          expect({ fromSql, fromQuery, fromMemory, fromDoor, fromUpdate }).toEqual({
            fromSql: expected,
            fromQuery: expected,
            fromMemory: expected,
            fromDoor: expected,
            fromUpdate: expected,
          });
        });
      }
    }
  }

  it("does NOT count an offer made to ANOTHER space, in any of the five", async () => {
    // The space narrowing of `placementShareJoin`, asked as a cell. The table
    // above seeds every offer in the space under test, so all five forms answer
    // it the same whether the join reads `(package, THIS space)` or `(package)`
    // alone — and the second is the silent widening the join's docstring warns
    // about, the one that turns "offered here" into "offered anywhere".
    const id = "@placement/offered-elsewhere";
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: elsewhere,
      draftManifest: { name: id, version: "0.1.0", type: "agent" },
    });
    await seedPackageShare(elsewhere, id);

    expect({
      fromSql: await sqlSaysPlaced(ctx.defaultSpaceId, id),
      fromQuery: await isPackageReadableInSpace(ctx.defaultSpaceId, id),
      fromMemory: placementGrantsRead(
        { homeSpaceId: elsewhere },
        [elsewhere],
        new Set([ctx.defaultSpaceId]),
      ),
      fromDoor: await doorSaysPlaced(ctx.defaultSpaceId, id),
      fromUpdate: await updateFilterSaysPlaced(ctx.defaultSpaceId, id),
    }).toEqual({
      fromSql: false,
      fromQuery: false,
      fromMemory: false,
      fromDoor: false,
      fromUpdate: false,
    });
  });

  it("does NOT count a space_packages row as a placement, in any of the five", async () => {
    // The ORPHAN — the residue `scripts/migration/0016` repairs, and the one
    // candidate that would let a space place a package nobody offered it. Two
    // columns carry the weight here: the DOOR is the only form that could
    // repair the orphan instead of refusing it, and `fromUpdate` is the only
    // one guarding a WRITE — an orphan it accepted would be a write no reader
    // can see back.
    const id = "@placement/orphan";
    await seedPackage({
      id,
      orgId: ctx.orgId,
      type: "agent",
      homeSpaceId: elsewhere,
      draftManifest: { name: id, version: "0.1.0", type: "agent" },
    });
    // The `space_packages` row exists IN THE SPACE UNDER TEST, switched on,
    // and nothing places it: the home is elsewhere and no offer was made here.
    await seedSpacePackage(ctx.defaultSpaceId, id, { enabled: true });

    expect({
      fromSql: await sqlSaysPlaced(ctx.defaultSpaceId, id),
      fromQuery: await isPackageReadableInSpace(ctx.defaultSpaceId, id),
      fromMemory: placementGrantsRead(
        { homeSpaceId: elsewhere },
        [],
        new Set([ctx.defaultSpaceId]),
      ),
      fromDoor: await doorSaysPlaced(ctx.defaultSpaceId, id),
      fromUpdate: await updateFilterSaysPlaced(ctx.defaultSpaceId, id),
    }).toEqual({
      fromSql: false,
      fromQuery: false,
      fromMemory: false,
      fromDoor: false,
      fromUpdate: false,
    });
  });
});

describe("the joins are owned, not copied", () => {
  /**
   * A placement-aware query carries TWO LEFT JOINs, both narrowed to (package,
   * THIS space), and getting either wrong fails the SAME quiet way: omitting
   * the join raises a Postgres `missing FROM-clause entry`, but joining on the
   * PACKAGE ALONE raises nothing. On `packageShares` that turns "offered to
   * THIS space" into "offered to any space at all"; on `spacePackages` it makes
   * `activeHereSql` read another space's `enabled` and a listing project
   * another space's model and proxy overrides. Both widen, silently.
   *
   * `placementShareJoin` and `placementRowJoin` take the space as a required
   * argument, so that mistake has nowhere to live. These two tests are what
   * keep the next reader from re-introducing it by hand: the ON clauses belong
   * to the module that owns the rule, and to nowhere else.
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
    const listed = Bun.spawnSync(["grep", "-rl", needle, "apps/api/src"]);
    const files = new TextDecoder()
      .decode(listed.stdout)
      .split("\n")
      .filter(Boolean)
      .filter((file) => !owners.includes(file))
      .sort();

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
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

  it("no source file writes the `packageShares` ON clause itself", () => {
    // `package-shares.ts` is the share service: it reads and deletes rows by
    // primary key, and `loadPackageShares` lists a package's audience.
    expect(
      handWrittenOnClauses("packageShares", [
        "apps/api/src/services/package-placement.ts",
        "apps/api/src/services/package-shares.ts",
      ]),
    ).toEqual([]);
  });

  it("no source file writes the `spacePackages` ON clause itself", () => {
    // Two owners beyond the module, and each writes a DIFFERENT shape rather
    // than a copy of this one:
    //   - `space-packages.ts` is the table's own service — the three writers
    //     and the transactional reads address one row by its (space, package)
    //     key, not by a join;
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
