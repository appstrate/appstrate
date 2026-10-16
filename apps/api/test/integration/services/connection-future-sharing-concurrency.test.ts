// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import {
  integrationConnections as c,
  integrationConnectionShares as shares,
  spaces,
} from "@appstrate/db/schema";
import { prefixedId } from "@appstrate/db/ids";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { testCaller } from "../../helpers/connection-shares.ts";
import { describeRequiresPostgres } from "../../helpers/tier.ts";
import { lockConnectionSharingOrg } from "../../../src/services/connection-future-shares.ts";
import {
  setConnectionFutureSharing,
  unshareConnection,
} from "../../../src/services/connection-shares.ts";
import { createSpace } from "../../../src/services/spaces.ts";

describeRequiresPostgres("future connection sharing serializes with space creation", () => {
  let ctx: TestContext;
  let connectionId: string;
  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "future-lock" });
    await seedPackage({ id: "@future-lock/svc", orgId: ctx.orgId, type: "integration" });
    const [row] = await db
      .insert(c)
      .values({
        integrationId: "@future-lock/svc",
        authKey: "key",
        orgId: ctx.orgId,
        spaceId: null,
        userId: ctx.user.id,
        accountId: "acct",
        label: "Shared",
        credentialsEncrypted: "x",
      })
      .returning({ id: c.id });
    connectionId = row!.id;
  });

  async function waitsForOrgLock(blockerPid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = toRows<{ waiting: boolean }>(
        await db.execute(
          sql`SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE NOT granted AND ${blockerPid} = ANY(pg_blocking_pids(pid))
          ) AS waiting`,
        ),
      );
      if (rows[0]!.waiting) return;
      await Bun.sleep(10);
    }
    throw new Error("policy/space write did not reach the org lock");
  }

  it("a new space sees the policy that commits while its creation is waiting", async () => {
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const policy = db.transaction(async (tx) => {
      await lockConnectionSharingOrg(tx, ctx.orgId);
      await tx.update(c).set({ shareNewSpaces: true }).where(eq(c.id, connectionId));
      locked.resolve(
        toRows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid,
      );
      await release.promise;
    });
    const blockerPid = await locked.promise;
    const creating = createSpace(ctx.orgId, { name: "Concurrent" });
    try {
      await waitsForOrgLock(blockerPid);
    } finally {
      release.resolve();
      await policy;
    }
    const space = await creating;
    expect(await db.select().from(shares).where(eq(shares.connectionId, connectionId))).toEqual([
      expect.objectContaining({ spaceId: space.id }),
    ]);
  });

  it("enabling the policy sees a space that commits while consent is waiting", async () => {
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const spaceId = prefixedId("spc");
    const creating = db.transaction(async (tx) => {
      await lockConnectionSharingOrg(tx, ctx.orgId);
      await tx.insert(spaces).values({ id: spaceId, orgId: ctx.orgId, name: "Concurrent" });
      locked.resolve(
        toRows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid,
      );
      await release.promise;
    });
    const blockerPid = await locked.promise;
    const policy = setConnectionFutureSharing({
      connectionId,
      integrationId: "@future-lock/svc",
      enabled: true,
      caller: testCaller(
        { kind: "person", actor: { type: "user", id: ctx.user.id } },
        { canShareAll: () => true },
      ),
    });
    try {
      await waitsForOrgLock(blockerPid);
    } finally {
      release.resolve();
      await creating;
    }
    await policy;
    expect(
      await db.select().from(shares).where(eq(shares.connectionId, connectionId)),
    ).toContainEqual(expect.objectContaining({ spaceId }));
  });
  it("withdrawal waits for space creation and switches off sharing before subsequent creations", async () => {
    const caller = testCaller(
      { kind: "person", actor: { type: "user", id: ctx.user.id } },
      { canShareAll: () => true },
    );
    const input = { connectionId, integrationId: "@future-lock/svc", caller };
    await setConnectionFutureSharing({ ...input, enabled: true });
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const concurrentId = prefixedId("spc");
    const creating = db.transaction(async (tx) => {
      await lockConnectionSharingOrg(tx, ctx.orgId);
      await tx.insert(spaces).values({ id: concurrentId, orgId: ctx.orgId, name: "Concurrent" });
      await tx.insert(shares).values({ connectionId, orgId: ctx.orgId, spaceId: concurrentId });
      locked.resolve(
        toRows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid,
      );
      await release.promise;
    });
    const blockerPid = await locked.promise;
    const withdrawal = unshareConnection({ ...input, spaceId: ctx.defaultSpaceId });
    try {
      await waitsForOrgLock(blockerPid);
    } finally {
      release.resolve();
      await creating;
    }
    expect((await withdrawal).connection.shareNewSpaces).toBe(false);
    const later = await createSpace(ctx.orgId, { name: "After withdrawal" });
    const remaining = await db.select().from(shares).where(eq(shares.connectionId, connectionId));
    expect(remaining.map((row) => row.spaceId)).toEqual([concurrentId]);
    expect(remaining.some((row) => row.spaceId === later.id)).toBe(false);
  });

  it("creation waiting behind a withdrawal sees specific-space mode", async () => {
    const caller = testCaller(
      { kind: "person", actor: { type: "user", id: ctx.user.id } },
      { canShareAll: () => true },
    );
    await setConnectionFutureSharing({
      connectionId,
      integrationId: "@future-lock/svc",
      caller,
      enabled: true,
    });
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const withdrawing = db.transaction(async (tx) => {
      await lockConnectionSharingOrg(tx, ctx.orgId);
      await tx.delete(shares).where(eq(shares.connectionId, connectionId));
      await tx.update(c).set({ shareNewSpaces: false }).where(eq(c.id, connectionId));
      locked.resolve(
        toRows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid,
      );
      await release.promise;
    });
    const blockerPid = await locked.promise;
    const creating = createSpace(ctx.orgId, { name: "After withdrawal" });
    try {
      await waitsForOrgLock(blockerPid);
    } finally {
      release.resolve();
      await withdrawing;
    }
    await creating;
    expect(await db.select().from(shares).where(eq(shares.connectionId, connectionId))).toEqual([]);
  });
});
