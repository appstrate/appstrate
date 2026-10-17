// SPDX-License-Identifier: Apache-2.0

/**
 * ONE definition of "active here", stated twice — and the two must agree.
 *
 * `services/package-activation.ts` carries the rule in SQL (`activeHereSql`,
 * consumed by the run gate, the hint listings, the per-type index pages and
 * the agents index) and in memory (`isActiveHere`, consumed by the two
 * activation doors, the integration resolver and the library's `state`). A
 * drift between them is not a cosmetic bug: it is a package the library shows
 * as off and the run gate lets through, or the reverse.
 *
 * The table below is every cell of the rule: four package types × three row
 * states (no row, a row saying `false`, a row saying `true`) × two provenances
 * (org-local, and the deployment's own — `source = "system"`, plus the
 * `SYSTEM_INTEGRATIONS` membership that decides an integration's default).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { packages, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../helpers/seed.ts";
import { activeHereSql, isActiveHere } from "../../../src/services/package-activation.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";
import type { PackageType } from "@appstrate/core/validation";

getTestApp();

let ctx: TestContext;
/** A second space, whose rows must decide nothing in the space under test. */
let elsewhere: string;

const TYPES: PackageType[] = ["agent", "skill", "mcp-server", "integration"];
const ROWS = [
  { label: "no row", row: null },
  { label: "a row saying false", row: { enabled: false } },
  { label: "a row saying true", row: { enabled: true } },
] as const;

/**
 * The SQL half, asked about ONE package in ONE space — with the join
 * `activeHereSql` documents.
 */
async function sqlSaysActive(spaceId: string, packageId: string): Promise<boolean> {
  const [hit] = await db
    .select({ active: sql<boolean>`${activeHereSql()}` })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, spaceId)),
    )
    .where(eq(packages.id, packageId))
    .limit(1);
  return hit!.active;
}

beforeEach(async () => {
  await truncateAll();
  ctx = await createTestContext();
  elsewhere = (await seedSpace({ orgId: ctx.orgId, name: "Elsewhere" })).id;
  __resetSystemIntegrationsForTest();
});

describe("the SQL mirror and the in-memory twin answer the same, cell for cell", () => {
  for (const type of TYPES) {
    for (const source of ["local", "system"] as const) {
      for (const { label, row } of ROWS) {
        it(`${type} / ${source} / ${label}`, async () => {
          const id = `@parity/${type}-${source}`;
          await seedPackage({
            id,
            orgId: source === "system" ? null : ctx.orgId,
            type,
            source,
            homeSpaceId: source === "system" ? null : elsewhere,
            draftManifest: { name: id, version: "0.1.0", type },
          });
          // A system-provenance INTEGRATION is only ON by default where the
          // deployment offers it: the platform ships ~65 integration packages
          // and `SYSTEM_INTEGRATIONS` names the subset that is auto-active.
          if (type === "integration" && source === "system") {
            initSystemIntegrations([{ id, clients: [] }]);
          }
          if (row) await seedSpacePackage(ctx.defaultSpaceId, id, { enabled: row.enabled });

          const fromSql = await sqlSaysActive(ctx.defaultSpaceId, id);
          const fromTs = isActiveHere({ id, type, source }, row);
          expect(fromTs).toBe(fromSql);

          // And the rule itself: the row wins, and the default only decides
          // where the space has said nothing.
          expect(fromSql).toBe(row ? row.enabled : source === "system");
        });
      }
    }
  }

  it("leaves a system-provenance integration the deployment does NOT offer inactive without a row", async () => {
    // The one narrowing in the rule, and the reason the default is not simply
    // `source = 'system'`: every bundled integration would otherwise be on in
    // every space, credentials and all.
    const id = "@parity/unoffered-integration";
    await seedPackage({
      id,
      orgId: null,
      type: "integration",
      source: "system",
      draftManifest: { name: id, version: "0.1.0", type: "integration" },
    });
    expect(await sqlSaysActive(ctx.defaultSpaceId, id)).toBe(false);
    expect(isActiveHere({ id, type: "integration", source: "system" }, null)).toBe(false);

    // …and an explicit row still wins, in both directions.
    await seedSpacePackage(ctx.defaultSpaceId, id, { enabled: true });
    expect(await sqlSaysActive(ctx.defaultSpaceId, id)).toBe(true);
    expect(isActiveHere({ id, type: "integration", source: "system" }, { enabled: true })).toBe(
      true,
    );
  });

  it("asks the space, not the table: another space's row decides nothing here", async () => {
    // The join is on (package, THIS space). Without it the rule reads any row
    // at all, which is a package switched off in one space going dark in every
    // other — the bug the explicit LEFT JOIN contract exists to prevent.
    //
    // The package has to be one whose default is ON, or the second read
    // answers `false` for the trivial reason and proves nothing: a local
    // package with no row here is inactive whether the join leaks or not.
    const id = "@parity/elsewhere";
    await seedPackage({
      id,
      orgId: null,
      type: "skill",
      source: "system",
      draftManifest: { name: id, version: "0.1.0", type: "skill" },
    });
    await seedSpacePackage(ctx.defaultSpaceId, id, { enabled: false });
    const rows = await db
      .select({ packageId: spacePackages.packageId })
      .from(spacePackages)
      .where(and(eq(spacePackages.packageId, id), isNotNull(spacePackages.packageId)));
    expect(rows).toHaveLength(1);
    expect(await sqlSaysActive(ctx.defaultSpaceId, id)).toBe(false);
    // Discriminant: the other space has no row, so the deployment default
    // decides there — `true`. A leaking join would answer `false`.
    expect(await sqlSaysActive(elsewhere, id)).toBe(true);
    expect(isActiveHere({ id, type: "skill", source: "system" }, undefined)).toBe(true);
  });
});
