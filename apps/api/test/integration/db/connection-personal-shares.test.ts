// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { getPGliteClient, reservePgConnection } from "@appstrate/db/client";
import {
  auditEvents,
  integrationConnections as c,
  integrationConnectionShares as shares,
} from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext } from "../../helpers/auth.ts";
import { seedPackage, seedSpace } from "../../helpers/seed.ts";
import { seedShares } from "../../helpers/connection-shares.ts";

async function repair() {
  const script = await Bun.file(
    new URL(
      "../../../../../scripts/migration/0047-connection-personal-shares.sql",
      import.meta.url,
    ),
  ).text();
  const embedded = getPGliteClient();
  const reserved = embedded ? null : await reservePgConnection();
  if (!embedded && !reserved) throw new Error("Test database unavailable");
  try {
    if (embedded) await embedded.exec(script);
    else await reserved!.sql.unsafe(script).simple();
  } catch (error) {
    if (embedded) await embedded.exec("ROLLBACK;");
    else await reserved!.sql.unsafe("ROLLBACK;").simple();
    throw error;
  } finally {
    reserved?.release();
  }
}

it("removes personal-space shares, audits each, and replays without writes", async () => {
  await truncateAll();
  const ctx = await createTestContext();
  await seedPackage({ id: "@repair/svc", orgId: ctx.orgId, type: "integration" });
  const personal = await seedSpace({
    orgId: ctx.orgId,
    ownerUserId: ctx.user.id,
    visibility: "private",
  });
  const team = await seedSpace({ orgId: ctx.orgId });
  const [mixed, personalOnly] = await db
    .insert(c)
    .values(
      [0, 1].map((i) => ({
        integrationId: "@repair/svc",
        authKey: "key",
        accountId: String(i),
        label: `Connection ${i}`,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
      })),
    )
    .returning();
  await seedShares(mixed!.id, [ctx.defaultSpaceId, team.id, personal.id]);
  await seedShares(personalOnly!.id, [personal.id]);
  await repair();
  expect(await db.select().from(shares).where(eq(shares.spaceId, personal.id))).toEqual([]);
  const kept = await db.select().from(shares).orderBy(shares.connectionId, shares.spaceId);
  expect(kept.map((row) => [row.connectionId, row.spaceId]).toSorted()).toEqual(
    [
      [mixed!.id, ctx.defaultSpaceId],
      [mixed!.id, team.id],
    ].toSorted(),
  );
  const audited = await db.select().from(auditEvents).orderBy(auditEvents.id);
  const removals = audited.filter((row) => row.action === "integration.connection.share_removed");
  expect(removals.map((row) => row.resourceId).toSorted()).toEqual(
    [mixed!.id, personalOnly!.id].toSorted(),
  );
  expect(removals.every((row) => row.spaceId === personal.id)).toBe(true);
  const connections = await db.select().from(c).orderBy(c.id);
  await repair();
  expect(await db.select().from(c).orderBy(c.id)).toEqual(connections);
  expect(await db.select().from(shares).orderBy(shares.connectionId, shares.spaceId)).toEqual(kept);
  expect(await db.select().from(auditEvents).orderBy(auditEvents.id)).toEqual(audited);
});
