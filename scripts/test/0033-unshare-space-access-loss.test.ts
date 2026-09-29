// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0033` against the test database: an owner who lost access before the deploy — still
 * in the organization but out of a closed space, or out of the organization — stops sharing there,
 * and only there. The predicate itself is `unshareConnectionsOfOwnersWithoutAccess`'s, covered by
 * `shared-connection-access-loss.test.ts`.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@appstrate/db/client";
import { integrationConnections } from "@appstrate/db/schema";
import { runUnshareSpaceAccessLoss } from "../migration/0033-unshare-space-access-loss.ts";
import { truncateAll } from "../../apps/api/test/helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
} from "../../apps/api/test/helpers/auth.ts";
import { seedPackage, seedSpace } from "../../apps/api/test/helpers/seed.ts";

const INTEGRATION = "@mig0033/svc";

async function seedSharedConnection(spaceId: string, userId: string): Promise<string> {
  const [row] = await db
    .insert(integrationConnections)
    .values({
      integrationId: INTEGRATION,
      authKey: "primary",
      accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
      spaceId,
      userId,
      credentialsEncrypted: "x",
      scopesGranted: [],
      sharedWithOrg: true,
      label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
    })
    .returning({ id: integrationConnections.id });
  return row!.id;
}

async function stillShared(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: integrationConnections.id, shared: integrationConnections.sharedWithOrg })
    .from(integrationConnections);
  return rows
    .filter((r) => r.shared && ids.includes(r.id))
    .map((r) => r.id)
    .sort();
}

describe("runUnshareSpaceAccessLoss", () => {
  let lost: string;
  let departed: string;
  let kept: string;
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
    lost = await seedSharedConnection(closed.id, member.id);
    kept = await seedSharedConnection(ctx.defaultSpaceId, member.id);
    // Shared by a user who left the organization: a `user` row, no `org_members` row.
    const leaver = await createTestUser();
    departed = await seedSharedConnection(ctx.defaultSpaceId, leaver.id);
  });

  it("writes nothing on a dry run", async () => {
    expect((await run(false)).sort()).toEqual([lost, departed].sort());
    expect(await stillShared([lost, departed, kept])).toEqual([lost, departed, kept].sort());
    expect(lines.at(-1)).toContain("DRY RUN");
  });

  it("unshares only where the owner lost the space, and finds nothing on a second run", async () => {
    expect((await run(true)).sort()).toEqual([lost, departed].sort());
    expect(await stillShared([lost, departed, kept])).toEqual([kept]);
    expect(await run(true)).toEqual([]);
  });
});
