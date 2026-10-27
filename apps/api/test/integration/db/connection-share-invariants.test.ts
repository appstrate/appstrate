// SPDX-License-Identifier: Apache-2.0

/**
 * The DB half of the two share rules: only a member's connection is shared, and a space-scoped
 * connection is shared into its own space only. Each write goes straight to the tables, so the
 * triggers are what refuse, not the share service: `ics_share_invariants` on a share,
 * `ics_connection_keeps_shares` on a connection that holds shares.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationConnectionShares } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser, seedSpace } from "../../helpers/seed.ts";
import { seedConnectionTestIntegration } from "../../helpers/run-connection-fixtures.ts";

const INTEGRATION = "@shareinv/integration";

/** What the database said: the constraint name sits in the cause's message, per driver. */
async function refusal(write: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error = (await write.then(
    () => undefined,
    (err: unknown) => err,
  )) as { message: string; cause?: { code?: string; message?: string } } | undefined;
  expect(error, "the statement was expected to be refused by the database").toBeDefined();
  return { code: error!.cause?.code, message: error!.cause?.message ?? error!.message };
}

describe("integration_connection_shares — share invariants", () => {
  let ctx: TestContext;
  let otherSpaceId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "shareinv" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    otherSpaceId = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
  });

  async function seedConnection(
    owner: { userId: string } | { endUserId: string },
    spaceId: string | null,
  ): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: "acct",
        orgId: ctx.orgId,
        spaceId,
        credentialsEncrypted: "x",
        label: "Connexion 1",
        ...owner,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  const updateConnection = (id: string, set: Partial<typeof integrationConnections.$inferInsert>) =>
    db
      .update(integrationConnections)
      .set(set)
      .where(eq(integrationConnections.id, id))
      .returning({ spaceId: integrationConnections.spaceId });

  const share = (connectionId: string, spaceId: string) =>
    db.insert(integrationConnectionShares).values({ connectionId, spaceId, orgId: ctx.orgId });

  it("refuses a share of an end user's connection (ics_end_user_not_shared)", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const id = await seedConnection({ endUserId: endUser.id }, ctx.defaultSpaceId);

    const refused = await refusal(share(id, ctx.defaultSpaceId));
    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("ics_end_user_not_shared");
  });

  it("refuses a space-scoped connection in another space (ics_space_shares_own)", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, ctx.defaultSpaceId);

    const refused = await refusal(share(id, otherSpaceId));
    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("ics_space_shares_own");
  });

  it("refuses moving a share to another space (ics_space_shares_own)", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, ctx.defaultSpaceId);
    await share(id, ctx.defaultSpaceId);

    const refused = await refusal(
      db
        .update(integrationConnectionShares)
        .set({ spaceId: otherSpaceId })
        .where(
          and(
            eq(integrationConnectionShares.connectionId, id),
            eq(integrationConnectionShares.spaceId, ctx.defaultSpaceId),
          ),
        ),
    );
    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("ics_space_shares_own");
  });

  it("accepts a space-scoped connection in its own space", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, ctx.defaultSpaceId);
    await share(id, ctx.defaultSpaceId);

    const rows = await db.select().from(integrationConnectionShares);
    expect(rows.map((row) => row.spaceId)).toEqual([ctx.defaultSpaceId]);
  });

  it("accepts an org-scoped member connection in any space of the org", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, null);
    await share(id, ctx.defaultSpaceId);
    await share(id, otherSpaceId);

    const rows = await db.select().from(integrationConnectionShares);
    expect(rows.map((row) => row.spaceId).sort()).toEqual(
      [ctx.defaultSpaceId, otherSpaceId].sort(),
    );
  });

  it("refuses narrowing a connection shared into another space (ics_space_shares_own)", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, null);
    await share(id, otherSpaceId);

    const refused = await refusal(updateConnection(id, { spaceId: ctx.defaultSpaceId }));
    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("ics_space_shares_own");
  });

  it("refuses handing a shared connection to an end user (ics_end_user_not_shared)", async () => {
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const id = await seedConnection({ userId: ctx.user.id }, ctx.defaultSpaceId);
    await share(id, ctx.defaultSpaceId);

    // A legal end-user row but for its share, so no CHECK of the table refuses first.
    const refused = await refusal(updateConnection(id, { userId: null, endUserId: endUser.id }));
    expect(refused.code).toBe("23514");
    expect(refused.message).toContain("ics_end_user_not_shared");
  });

  it("accepts widening a shared connection to the org", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, ctx.defaultSpaceId);
    await share(id, ctx.defaultSpaceId);

    expect(await updateConnection(id, { spaceId: null })).toEqual([{ spaceId: null }]);
  });

  it("accepts narrowing a connection that holds no share", async () => {
    const id = await seedConnection({ userId: ctx.user.id }, null);

    expect(await updateConnection(id, { spaceId: otherSpaceId })).toEqual([
      { spaceId: otherSpaceId },
    ]);
  });
});
