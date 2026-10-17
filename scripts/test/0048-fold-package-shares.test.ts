// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0048` against the test database: each `package_shares` row becomes the
 * `space_packages` row of its (space, package), switched off, with `shared_by` copied; a space
 * that had already activated the package keeps its row and gains the `shared_by` it lacked; a dry
 * run writes nothing; `--apply` empties `package_shares`, so a second `--apply` writes nothing; a
 * share naming a space of another organization is skipped, reported and deleted; a row placing
 * its package nowhere under the old rule (an orphan, cross-org included) is reported and deleted;
 * per-space placements are equal before (old rule) and after (new rule), or nothing commits.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packageShares, spacePackages } from "@appstrate/db/schema";
import { runFoldPackageShares } from "../migration/0048-fold-package-shares.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import { createTestContext, type TestContext } from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedSpace, seedSpacePackage } from "../../apps/api/test/helpers/seed.ts";

const AGENT = "@mig0048/agent";
const SKILL = "@mig0048/skill";

let ctx: TestContext;
let home: string;
const lines: string[] = [];
const run = (apply: boolean) => runFoldPackageShares({ apply, out: (line) => lines.push(line) });

type Row = { spaceId: string; packageId: string; enabled: boolean; sharedBy: string | null };
const byKey = (a: Row, b: Row) =>
  `${a.packageId} ${a.spaceId}`.localeCompare(`${b.packageId} ${b.spaceId}`);
const sorted = (list: Row[]) => [...list].sort(byKey);

async function rows(): Promise<Row[]> {
  const list = await db
    .select({
      spaceId: spacePackages.spaceId,
      packageId: spacePackages.packageId,
      enabled: spacePackages.enabled,
      sharedBy: spacePackages.sharedBy,
    })
    .from(spacePackages);
  return sorted(list);
}

describe("0048 — package shares folded into space_packages", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0048" });
    home = (await seedSpace({ orgId: ctx.orgId, name: "Home" })).id;
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent", homeSpaceId: home });
    await seedPackage({ id: SKILL, orgId: ctx.orgId, type: "skill", homeSpaceId: home });
  });

  it("a dry run writes nothing; --apply folds every share; a second --apply inserts 0", async () => {
    const team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    // Shared, never activated: becomes a row switched off.
    await db
      .insert(packageShares)
      .values({ packageId: AGENT, spaceId: team, sharedBy: ctx.user.id });
    // Shared AND activated: the row keeps its state and gains its sharer.
    await db
      .insert(packageShares)
      .values({ packageId: SKILL, spaceId: team, sharedBy: ctx.user.id });
    await seedSpacePackage(team, SKILL, { enabled: true });
    await seedSpacePackage(home, AGENT, { enabled: true });

    const dry = await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("package_shares: 2, to fold: 1");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(dry).toMatchObject({ inserted: 1, sharedByCopied: 1, skipped: [], emptied: 2 });
    expect(await db.select().from(packageShares)).toHaveLength(2);
    expect(await rows()).toEqual(
      sorted([
        { spaceId: home, packageId: AGENT, enabled: true, sharedBy: null },
        { spaceId: team, packageId: SKILL, enabled: true, sharedBy: null },
      ]),
    );

    lines.length = 0;
    const applied = await run(true);
    expect(applied).toMatchObject({ inserted: 1, sharedByCopied: 1, emptied: 2 });
    expect(lines).toContain("package_shares emptied: 2");
    expect(await db.select().from(packageShares)).toEqual([]);
    expect(lines).toContain("inserted: 1, shared_by copied: 1, skipped: 0, orphans deleted: 0");
    expect(lines.at(-1)).toBe("0048: APPLIED — committed.");
    expect(await rows()).toEqual(
      sorted([
        { spaceId: home, packageId: AGENT, enabled: true, sharedBy: null },
        { spaceId: team, packageId: AGENT, enabled: false, sharedBy: ctx.user.id },
        { spaceId: team, packageId: SKILL, enabled: true, sharedBy: ctx.user.id },
      ]),
    );
    // Home ∨ share ∨ row before, home ∨ row after: equal in every space.
    expect(applied.placements.every((p) => p.before === p.after)).toBe(true);
    expect(applied.placements.find((p) => p.spaceId === team)).toEqual({
      spaceId: team,
      before: 2,
      after: 2,
    });
    expect(lines).toContain(`  ${team}: 2 → 2`);

    lines.length = 0;
    expect(await run(true)).toMatchObject({ inserted: 0, sharedByCopied: 0, emptied: 0 });
    expect(lines).toContain("package_shares: 0, to fold: 0");
    // Folded rows have no share left, yet a re-run must not take them for orphans.
    expect(await rows()).toHaveLength(3);
  });

  it("leaves a row's existing sharer alone", async () => {
    const team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    const other = await createTestContext({ orgSlug: "mig0048-sharer" });
    await db
      .insert(packageShares)
      .values({ packageId: AGENT, spaceId: team, sharedBy: ctx.user.id });
    await seedSpacePackage(team, AGENT, { enabled: false, sharedBy: other.user.id });

    expect(await run(true)).toMatchObject({ inserted: 0, sharedByCopied: 0 });
    expect((await rows()).find((row) => row.spaceId === team)?.sharedBy).toBe(other.user.id);
  });

  it("skips, reports and deletes a share naming another organization's space", async () => {
    const stranger = await createTestContext({ orgSlug: "mig0048-other" });
    await db
      .insert(packageShares)
      .values({ packageId: AGENT, spaceId: stranger.defaultSpaceId, sharedBy: null });

    const result = await run(true);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toEqual([{ packageId: AGENT, spaceId: stranger.defaultSpaceId }]);
    expect(lines).toContain(`  skipped ${AGENT} → ${stranger.defaultSpaceId}: foreign space`);
    expect(result.emptied).toBe(1);
    expect(await db.select().from(packageShares)).toEqual([]);
    expect(await db.select().from(spacePackages).where(eq(spacePackages.packageId, AGENT))).toEqual(
      [],
    );
  });

  it("deletes an orphan row and a cross-org row, reporting each with its switch", async () => {
    const team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    const shared = (await seedSpace({ orgId: ctx.orgId, name: "Shared" })).id;
    const stranger = await createTestContext({ orgSlug: "mig0048-orphan" });
    await db
      .insert(packageShares)
      .values({ packageId: AGENT, spaceId: shared, sharedBy: ctx.user.id });
    // Outside the home, no share: placed nowhere before, would be live after.
    await seedSpacePackage(team, AGENT, { enabled: true });
    await seedSpacePackage(stranger.defaultSpaceId, SKILL, { enabled: false });

    const result = await run(true);
    expect(result.orphans).toEqual([
      { packageId: AGENT, spaceId: team, enabled: true, crossOrg: false },
      { packageId: SKILL, spaceId: stranger.defaultSpaceId, enabled: false, crossOrg: true },
    ]);
    expect(lines).toContain(`  orphan ${AGENT} → ${team}: enabled=true — deleted`);
    expect(lines).toContain(
      `  orphan ${SKILL} → ${stranger.defaultSpaceId}: enabled=false, foreign space — deleted`,
    );
    expect(await rows()).toEqual([
      { spaceId: shared, packageId: AGENT, enabled: false, sharedBy: ctx.user.id },
    ]);
    expect(result.placements.find((p) => p.spaceId === team)).toBeUndefined();
    expect(result.placements.every((p) => p.before === p.after)).toBe(true);
  });

  it("rolls everything back when a space's placements differ", async () => {
    const team = (await seedSpace({ orgId: ctx.orgId, name: "Team" })).id;
    await db
      .insert(packageShares)
      .values({ packageId: AGENT, spaceId: team, sharedBy: ctx.user.id });
    await seedSpacePackage(team, SKILL, { enabled: true });
    // A fold that drops its insert: the share would place nothing after.
    await db.execute(sql`CREATE FUNCTION mig0048_drop() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RETURN NULL; END $$`);
    await db.execute(sql`CREATE TRIGGER mig0048_drop BEFORE INSERT ON space_packages
      FOR EACH ROW EXECUTE FUNCTION mig0048_drop()`);
    try {
      await expect(run(true)).rejects.toThrow(/placements differ in 1 space\(s\): /);
    } finally {
      await db.execute(sql`DROP TRIGGER mig0048_drop ON space_packages`);
      await db.execute(sql`DROP FUNCTION mig0048_drop()`);
    }
    expect(await db.select().from(packageShares)).toHaveLength(1);
    // The orphan deletion rolled back with it.
    expect(await rows()).toEqual([
      { spaceId: team, packageId: SKILL, enabled: true, sharedBy: null },
    ]);
  });
});
