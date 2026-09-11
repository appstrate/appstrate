// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import { and, eq, isNotNull } from "drizzle-orm";
import { organizationMembers, packages, spaces } from "@appstrate/db/schema";
import { getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, createTestUser, type TestContext } from "../../helpers/auth.ts";
import { seedInstalledPackage, seedPackage, seedSpace } from "../../helpers/seed.ts";

async function backfill(file: string) {
  const script = await Bun.file(
    new URL(`../../../../../scripts/migration/${file}`, import.meta.url),
  ).text();
  const embedded = getPGliteClient();
  if (embedded) {
    await embedded.exec(script);
    return;
  }
  const connection = await reservePgConnection();
  if (!connection) throw new Error("PostgreSQL test connection unavailable");
  try {
    await connection.sql.unsafe(script).simple();
  } finally {
    connection.release();
  }
}

describe("personal-space rollout scripts on migrated data", () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
  });

  it("assigns homes within the org, leaves uninstalled packages alone and preserves operator choices on replay", async () => {
    const newer = await seedSpace({ orgId: ctx.orgId });
    for (const name of ["single", "multiple", "uninstalled"]) {
      await seedPackage({ id: `@backfill/${name}`, orgId: ctx.orgId, type: "agent" });
    }
    await seedInstalledPackage(ctx.defaultSpaceId, "@backfill/single");
    await seedInstalledPackage(ctx.defaultSpaceId, "@backfill/multiple", {
      installedAt: new Date("2020-01-01"),
    });
    await seedInstalledPackage(newer.id, "@backfill/multiple", {
      installedAt: new Date("2021-01-01"),
    });
    await backfill("0014-packages-home-space-backfill.sql");
    const rows = await db
      .select({ id: packages.id, home: packages.homeSpaceId })
      .from(packages)
      .where(eq(packages.orgId, ctx.orgId));
    expect(Object.fromEntries(rows.map((row) => [row.id, row.home]))).toEqual({
      "@backfill/single": ctx.defaultSpaceId,
      "@backfill/multiple": ctx.defaultSpaceId,
      "@backfill/uninstalled": null,
    });
    await db
      .update(packages)
      .set({ homeSpaceId: newer.id })
      .where(eq(packages.id, "@backfill/multiple"));
    await backfill("0014-packages-home-space-backfill.sql");
    const [moved] = await db.select().from(packages).where(eq(packages.id, "@backfill/multiple"));
    expect(moved!.homeSpaceId).toBe(newer.id);
  });

  it("provisions exactly one private space per live membership and does not revive an orphan on replay", async () => {
    const departed = await createTestUser();
    const orphan = await seedSpace({
      orgId: ctx.orgId,
      ownerUserId: departed.id,
      visibility: "private",
      orphanedAt: new Date(),
    });
    const liveMembers = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, ctx.orgId));
    await backfill("0015-personal-spaces-backfill.sql");
    const readPersonal = () =>
      db
        .select()
        .from(spaces)
        .where(and(eq(spaces.orgId, ctx.orgId), isNotNull(spaces.ownerUserId)));
    const first = await readPersonal();
    expect(first).toHaveLength(liveMembers.length + 1);
    for (const row of first) {
      expect(row.visibility).toBe("private");
      expect(row.isDefault).toBe(false);
    }
    await backfill("0015-personal-spaces-backfill.sql");
    const replayed = await readPersonal();
    expect(replayed.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());
    expect(replayed.find((row) => row.id === orphan.id)!.orphanedAt).not.toBeNull();
  });
});
