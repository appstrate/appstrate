// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0033` against the test database: an owner who lost access before the deploy — still
 * in the organization but out of a closed space, or out of the organization — stops sharing there,
 * and only there, in every organization. The predicate itself is
 * `unshareConnectionsOfOwnersWithoutAccess`'s, covered by `shared-connection-access-loss.test.ts`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationConnectionShares } from "@appstrate/db/schema";
import { runUnshareSpaceAccessLoss } from "../migration/0033-unshare-space-access-loss.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
} from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedSpace, seedSpaceMember } from "../../apps/api/test/helpers/seed.ts";

const INTEGRATION = "@mig0033/svc";

async function seedSharedConnection(
  orgId: string,
  spaceId: string,
  owner: { userId: string },
): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      orgId,
      spaceId,
      ...owner,
      credentialsEncrypted: "x",
      scopesGranted: [],
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  await db.insert(integrationConnectionShares).values({ connectionId: row!.id, spaceId, orgId });
  return row!.id;
}

async function stillShared(ids: string[]): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: integrationConnectionShares.connectionId })
    .from(integrationConnectionShares);
  return rows
    .map((r) => r.id)
    .filter((id) => ids.includes(id))
    .sort();
}

describe("runUnshareSpaceAccessLoss", () => {
  let lost: string;
  let departed: string;
  let otherOrgDeparted: string;
  /** Still reached by their owner: shared after every run. */
  let kept: string[];
  const lines: string[] = [];
  const run = (apply: boolean) =>
    runUnshareSpaceAccessLoss({ apply, out: (line) => lines.push(line) });

  beforeEach(async () => {
    await truncateAll();
    lines.length = 0;
    const ctx = await createTestContext({ orgSlug: "mig0033" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration" });
    const member = await createTestUser();
    await addOrgMember(ctx.orgId, member.id, "member");
    // Shared in a closed space the member holds no row in: access lost before the deploy.
    const closed = await seedSpace({ orgId: ctx.orgId, visibility: "closed" });
    lost = await seedSharedConnection(ctx.orgId, closed.id, { userId: member.id });
    // An explicit member of the same closed space still reaches it.
    const insider = await createTestUser();
    await addOrgMember(ctx.orgId, insider.id, "member");
    await seedSpaceMember({ spaceId: closed.id, userId: insider.id });
    kept = [
      await seedSharedConnection(ctx.orgId, ctx.defaultSpaceId, { userId: member.id }),
      await seedSharedConnection(ctx.orgId, closed.id, { userId: insider.id }),
    ];
    // Shared by a user who left the organization: a `user` row, no `org_members` row.
    const leaver = await createTestUser();
    departed = await seedSharedConnection(ctx.orgId, ctx.defaultSpaceId, { userId: leaver.id });
    // A second organization with its own leaver: the per-org loop reaches it too.
    const other = await createTestContext({ orgSlug: "mig0033b" });
    otherOrgDeparted = await seedSharedConnection(other.orgId, other.defaultSpaceId, {
      userId: (await createTestUser()).id,
    });
  });

  it("names the database first, and writes nothing on a dry run", async () => {
    const all = [lost, departed, otherOrgDeparted, ...kept];
    expect((await run(false)).sort()).toEqual([lost, departed, otherOrgDeparted].sort());
    expect(await stillShared(all)).toEqual(all.sort());
    expect(lines[0]).toStartWith("database: ");
    expect(lines.at(-1)).toContain("DRY RUN");
  });

  it("unshares only where the owner lost the space, in every organization, and finds nothing on a second run", async () => {
    const all = [lost, departed, otherOrgDeparted, ...kept];
    expect((await run(true)).sort()).toEqual([lost, departed, otherOrgDeparted].sort());
    expect(await stillShared(all)).toEqual(kept.sort());
    expect(lines.at(-1)).toBe(
      '  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ran_0033=1 -f scripts/migration/0032-connection-sets.sql',
    );
    expect(await run(true)).toEqual([]);
  });
});
