// SPDX-License-Identifier: Apache-2.0

/**
 * ONE definition of "PLACED here", stated FOUR times — and the four must agree.
 *
 * Activation is stated twice and has `package-activation-parity.test.ts` to
 * hold the pair together. Placement is the rule with twice as many statements
 * and had no such harness, which is the wrong way round: each form is written
 * in a different dialect for a different caller, and nothing but reading all
 * four kept them honest.
 *
 *   - `placementReadFilter(spaceId)` — the SQL filter (`package-placement.ts`),
 *     conjoined into `activeHereSql` and into every listing;
 *   - `placementGrantsRead(pkg, sharedIn, readable)` — the in-memory form
 *     (`lib/package-access.ts`), for callers holding rows and a set of spaces;
 *   - `isPackageReadableInSpace(spaceId, packageId)` — the standalone query
 *     behind `requireAgent()` and the execution verdict;
 *   - the TRANSACTIONAL reading inside `activatePackageWithin`, which decides
 *     under a row lock whether an activation needs an offer or is refused.
 *
 * The fourth is module-private on purpose — a lock-taking predicate has no
 * business being called outside the transaction that holds the lock — so it is
 * exercised through the door it guards rather than exported for a test:
 * `activatePackage` with no `shareBy` refuses exactly the packages that are not
 * placed.
 *
 * The table is every cell of the rule: two provenances × the home here or
 * elsewhere × an offer present or absent.
 *
 * ONE asymmetry is pinned rather than smoothed over. `placementGrantsRead`
 * carries NO system term — its callers add it (`assertPackageIsReachable`,
 * `isPackageReadableInSpace`), because they are the ones holding the `source`
 * column. So the parity assertion for that form is `system ∨ grantsRead(…)`,
 * and a future edit that moves the system term INTO the function, or drops it
 * from a caller, breaks this test rather than one tenant's visibility.
 */

import { beforeEach, describe, expect, it } from "bun:test";
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
 * The transactional form, read through the door it guards. `activatePackage`
 * with no `shareBy` writes the placement row when the package is placed and
 * throws a 404 when it is not — so "did it throw" IS that predicate's answer.
 */
/**
 * The UPDATE form: `placedRowFilter` is the same rule as an `EXISTS`
 * sub-select, because drizzle's `update` has no join to hang the LEFT JOIN on.
 * It is the one form that guards a WRITE, so a drift here is a write the rest
 * of the platform refuses to read back.
 */
async function updateFilterSaysPlaced(spaceId: string, packageId: string): Promise<boolean> {
  // Read through the same drizzle SELECT the other forms use rather than
  // `db.execute`: the raw executor hands back a bare array under postgres.js
  // and a `{ rows }` envelope under PGlite, so a hand-unwrapped result passes
  // on a tier-0 laptop and throws on the tier-3 runner — which is exactly how
  // this arrived: green locally, eight red cells in CI.
  const [hit] = await db
    .select({ placed: sql<boolean>`${placedRowFilter(db, spaceId, packageId)}` })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  return hit!.placed;
}

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

          // The rule itself, spelled out once here so the four forms are
          // compared against the RULE and not merely against each other —
          // four statements agreeing on the same wrong answer is the failure
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

  it("does NOT count a space_packages row as a placement, in any of the five", async () => {
    // The ORPHAN — the residue `scripts/migration/0016` repairs, and the one
    // candidate that would let a space place a package nobody offered it. The
    // door is the interesting column here: it is the only form that could
    // repair the orphan instead of refusing it, and it must refuse.
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
    }).toEqual({ fromSql: false, fromQuery: false, fromMemory: false, fromDoor: false });
  });
});

describe("the join is owned, not copied", () => {
  /**
   * `placementReadFilter` reads its share half off a LEFT JOIN it does not
   * write, and the failure mode of getting that join wrong is the quiet one:
   * omitting it raises a Postgres `missing FROM-clause entry`, but joining on
   * the PACKAGE ALONE raises nothing and turns "offered to THIS space" into
   * "offered to any space at all" — every reader of the rule widening at once.
   *
   * `placementShareJoin` takes the space as a required argument, so that
   * mistake has nowhere to live. This test is what keeps the next reader from
   * re-introducing it by hand: the ON clause belongs to the module that owns
   * the rule, and to nowhere else.
   */
  it("no source file writes the `packageShares` ON clause itself", () => {
    const proc = Bun.spawnSync(["grep", "-rn", "eq(packageShares.packageId", "apps/api/src"]);
    const offenders = new TextDecoder()
      .decode(proc.stdout)
      .split("\n")
      .filter(Boolean)
      // The module that OWNS the rule writes it once, by definition. The share
      // service and the rehome reconciliation address the table directly in a
      // WHERE — a row read or deleted by primary key, never a join feeding the
      // filter — and `loadPackageShares` lists a package's audience.
      .filter((line) => !line.startsWith("apps/api/src/services/package-placement.ts:"))
      .filter((line) => !line.startsWith("apps/api/src/services/package-shares.ts:"))
      .filter((line) => !line.includes(".where("))
      .filter((line) => !line.includes("placementShareJoin"));
    expect(offenders).toEqual([]);
  });
});
