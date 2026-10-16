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
    new URL("../../../../../scripts/migration/0046-connection-sharing-modes.sql", import.meta.url),
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

it("repairs personal shares and hybrid modes without restoring access, and replays without writes", async () => {
  await truncateAll();
  const ctx = await createTestContext();
  await seedPackage({ id: "@repair/svc", orgId: ctx.orgId, type: "integration" });
  const personal = await seedSpace({
    orgId: ctx.orgId,
    ownerUserId: ctx.user.id,
    visibility: "private",
  });
  const team = await seedSpace({ orgId: ctx.orgId });
  const [all, hybrid, specific] = await db
    .insert(c)
    .values(
      [true, true, false].map((shareNewSpaces, i) => ({
        integrationId: "@repair/svc",
        authKey: "key",
        accountId: String(i),
        label: `Connection ${i}`,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        shareNewSpaces,
      })),
    )
    .returning();
  await seedShares(all!.id, [ctx.defaultSpaceId, team.id, personal.id]);
  await seedShares(hybrid!.id, [ctx.defaultSpaceId]);
  await seedShares(specific!.id, [personal.id]);
  await repair();
  const connections = await db.select().from(c).orderBy(c.id);
  expect(connections.find((row) => row.id === all!.id)!.shareNewSpaces).toBe(true);
  expect(connections.find((row) => row.id === hybrid!.id)!.shareNewSpaces).toBe(false);
  expect(connections.find((row) => row.id === specific!.id)!.shareNewSpaces).toBe(false);
  expect(await db.select().from(shares).where(eq(shares.spaceId, personal.id))).toEqual([]);
  const kept = await db.select().from(shares).orderBy(shares.connectionId, shares.spaceId);
  expect(kept).toHaveLength(3);
  expect(kept.filter((row) => row.connectionId === hybrid!.id).map((row) => row.spaceId)).toEqual([
    ctx.defaultSpaceId,
  ]);
  const audited = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(audited.filter((row) => row.action.startsWith("integration.connection."))).toHaveLength(3);
  await repair();
  expect(await db.select().from(c).orderBy(c.id)).toEqual(connections);
  expect(await db.select().from(shares).orderBy(shares.connectionId, shares.spaceId)).toEqual(kept);
  expect(await db.select().from(auditEvents).orderBy(auditEvents.id)).toEqual(audited);
});
