// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0044` against the test database: each space id in `shared_space_ids` becomes a share
 * row, audited by the `system` actor, and the column is emptied; a dry run writes nothing; a second
 * `--apply` inserts nothing, so a share withdrawn in between stays withdrawn; a target space that no
 * longer exists or belongs to another organization is skipped and reported.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  auditEvents,
  integrationConnections,
  integrationConnectionShares,
} from "@appstrate/db/schema";
import { runConnectionShares } from "../migration/0044-connection-shares.ts";
import { unshareConnection } from "../../apps/api/src/services/connection-shares.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedSpace } from "../../apps/api/test/helpers/seed.ts";

const INTEGRATION = "@mig0044/svc";

let ctx: TestContext;
const lines: string[] = [];
const run = (apply: boolean) => runConnectionShares({ apply, out: (line) => lines.push(line) });

async function seedOrgConnection(sharedSpaceIds: string[], userId = ctx.user.id): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId: ctx.orgId,
      spaceId: null,
      userId,
      credentialsEncrypted: "x",
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
      sharedSpaceIds,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function sharedSpaceIdsOf(id: string): Promise<string[]> {
  const [row] = await db
    .select({ sharedSpaceIds: integrationConnections.sharedSpaceIds })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row!.sharedSpaceIds;
}

async function audits() {
  const rows = await db
    .select({
      action: auditEvents.action,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      spaceId: auditEvents.spaceId,
      resourceId: auditEvents.resourceId,
      after: auditEvents.after,
    })
    .from(auditEvents)
    .where(eq(auditEvents.resourceType, "integration_connection"))
    .orderBy(asc(auditEvents.action), asc(auditEvents.spaceId));
  return rows;
}

async function shares() {
  const rows = await db.select().from(integrationConnectionShares);
  return rows
    .map(({ connectionId, spaceId, sharedBy }) => ({ connectionId, spaceId, sharedBy }))
    .sort((a, b) => `${a.connectionId}${a.spaceId}`.localeCompare(`${b.connectionId}${b.spaceId}`));
}

describe("0044 — connection shares copied into integration_connection_shares", () => {
  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    ctx = await createTestContext({ orgSlug: "mig0044" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  it("a dry run writes nothing; --apply makes one row per shared space; a second --apply inserts 0", async () => {
    const s1 = ctx.defaultSpaceId;
    const s2 = (await seedSpace({ orgId: ctx.orgId })).id;
    const id = await seedOrgConnection([s1, s2]);

    const dry = await run(false);
    expect(lines[0]).toStartWith("database: ");
    expect(lines).toContain("shares in shared_space_ids: 2, to copy: 2");
    expect(lines.at(-1)).toContain("DRY RUN");
    expect(dry.inserted).toBe(2);
    expect(await shares()).toEqual([]);

    lines.length = 0;
    expect((await run(true)).inserted).toBe(2);
    expect(lines.at(-1)).toBe("0044: APPLIED — committed.");
    const expected = [s1, s2]
      .map((spaceId) => ({ connectionId: id, spaceId, sharedBy: null }))
      .sort((a, b) => a.spaceId.localeCompare(b.spaceId));
    expect(await shares()).toEqual(expected);

    expect(lines).toContain("shared_space_ids emptied: 1");
    expect(await sharedSpaceIdsOf(id)).toEqual([]);
    expect(await audits()).toEqual(
      [s1, s2].sort().map((spaceId) => ({
        action: "integration.connection.share_added",
        actorType: "system",
        actorId: null,
        spaceId,
        resourceId: id,
        after: { spaceId },
      })),
    );

    lines.length = 0;
    expect((await run(true)).inserted).toBe(0);
    expect(lines).toContain("shares in shared_space_ids: 0, to copy: 0");
    expect(await shares()).toEqual(expected);
  });

  it("keeps a share the owner withdrew between two --apply runs withdrawn", async () => {
    const s2 = (await seedSpace({ orgId: ctx.orgId })).id;
    const id = await seedOrgConnection([ctx.defaultSpaceId, s2]);
    expect((await run(true)).inserted).toBe(2);

    const { removed } = await unshareConnection({
      connectionId: id,
      spaceId: s2,
      viewer: {
        principal: { kind: "person", actor: { type: "user", id: ctx.user.id } },
        spaceId: null,
        integrationId: null,
        governs: false,
        permissionsIn: async () => new Set(),
      },
    });
    expect(removed).toBe(true);

    expect((await run(true)).inserted).toBe(0);
    expect(await shares()).toEqual([
      { connectionId: id, spaceId: ctx.defaultSpaceId, sharedBy: null },
    ]);
  });

  it("skips and reports a deleted space and another organization's space", async () => {
    const other = await createTestContext({ orgSlug: "mig0044-other" });
    const gone = "spc_gone0044";
    const id = await seedOrgConnection([ctx.defaultSpaceId, gone, other.defaultSpaceId]);

    const result = await run(true);
    expect(result.inserted).toBe(1);
    const bySpace = (a: { spaceId: string }, b: { spaceId: string }) =>
      a.spaceId.localeCompare(b.spaceId);
    expect([...result.skipped].sort(bySpace)).toEqual(
      [
        { connectionId: id, spaceId: gone, reason: "missing" as const },
        { connectionId: id, spaceId: other.defaultSpaceId, reason: "foreign" as const },
      ].sort(bySpace),
    );
    expect(lines).toContain(`  skipped ${id} → ${gone}: missing space`);
    expect(lines).toContain(`  skipped ${id} → ${other.defaultSpaceId}: foreign space`);
    expect(lines).toContain("inserted: 1, skipped: 2");
    expect(await shares()).toEqual([
      { connectionId: id, spaceId: ctx.defaultSpaceId, sharedBy: null },
    ]);
  });

  it("withdraws a copied share whose owner no longer reaches the target space", async () => {
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    // A closed space the member holds no row in: access lost after the deploy.
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    const id = await seedOrgConnection([ctx.defaultSpaceId, closed.id], member.id);

    const result = await run(true);
    expect(result.inserted).toBe(2);
    expect(result.withdrawn).toEqual([{ connectionId: id, spaceId: closed.id }]);
    expect(lines).toContain(`  withdrawn ${id} → ${closed.id}: owner without access`);
    expect(lines).toContain("withdrawn (owner without access): 1, schedules disabled: 0");
    expect(await shares()).toEqual([
      { connectionId: id, spaceId: ctx.defaultSpaceId, sharedBy: null },
    ]);
    expect(
      (await audits()).filter((a) => a.action === "integration.connection.share_removed"),
    ).toEqual([
      {
        action: "integration.connection.share_removed",
        actorType: "system",
        actorId: null,
        spaceId: closed.id,
        resourceId: id,
        after: { spaceId: closed.id, reason: "access_lost" },
      },
    ]);
  });
});
