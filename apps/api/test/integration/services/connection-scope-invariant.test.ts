// SPDX-License-Identifier: Apache-2.0

/**
 * A connection's scope is the tier of the client that minted it (#1870): a member's row minted by
 * a system client, an org client or no client serves the org; a space client's row and an end
 * user's row serve their space. Every write path keeps it: connect, promote, reconnect.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { and, eq, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { integrationConnections as ic, integrationOauthClients } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser, seedPackage, seedSpace } from "../../helpers/seed.ts";
import {
  promoteIntegrationOAuthClient,
  saveIntegrationConnection,
} from "../../../src/services/integration-connections.ts";
import type { Actor } from "../../../src/lib/actor.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

const INTEGRATION = "@orga/probe";
const AUTH_KEY = "oauth";
const SYSTEM_ID = "probe-system";

/** Rows whose scope is not their minting client's tier. */
async function scopeViolations(): Promise<string[]> {
  const o = integrationOauthClients;
  const spaceClient = sql`EXISTS (SELECT 1 FROM ${o} WHERE ${o.id}::text = ${ic.clientRef} AND ${o.spaceId} IS NOT NULL)`;
  const rows = await db
    .select({ id: ic.id })
    .from(ic)
    .where(
      or(
        and(isNull(ic.spaceId), or(isNotNull(ic.endUserId), spaceClient)),
        and(isNotNull(ic.spaceId), isNotNull(ic.userId), not(spaceClient)),
      ),
    );
  return rows.map((row) => row.id);
}

describe("connection scope = minting client tier", () => {
  let ctx: TestContext;
  let spaceA: SpaceScope;
  let spaceB: SpaceScope;
  let member: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orga" });
    spaceA = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    const b = await seedSpace({ orgId: ctx.orgId, name: "B" });
    spaceB = { orgId: ctx.orgId, spaceId: b.id };
    member = { type: "user", id: ctx.user.id };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  async function seedClient(spaceId: string | null, clientId: string): Promise<string> {
    const [row] = await db
      .insert(integrationOauthClients)
      .values({
        orgId: ctx.orgId,
        spaceId,
        integrationId: INTEGRATION,
        authKey: AUTH_KEY,
        clientId,
        clientSecretEncrypted: "unused",
      })
      .returning({ id: integrationOauthClients.id });
    return row!.id;
  }

  function connect(
    scope: SpaceScope,
    actor: Actor,
    clientRef?: string,
    connectionId?: string,
  ): ReturnType<typeof saveIntegrationConnection> {
    return saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: AUTH_KEY,
      accountId: "default",
      credentials: { access_token: "t" },
      actor,
      ...(clientRef !== undefined ? { clientRef } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
    });
  }

  it("holds across connect, promote and reconnect", async () => {
    const orgClient = await seedClient(null, "org-client");
    const spaceClientA = await seedClient(spaceA.spaceId, "space-a");
    const spaceClientB = await seedClient(spaceB.spaceId, "space-b");
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: spaceA.spaceId });

    expect((await connect(spaceA, member, SYSTEM_ID)).scope).toBe("org");
    expect((await connect(spaceA, member, orgClient)).scope).toBe("org");
    expect((await connect(spaceA, member)).scope).toBe("org");
    expect((await connect(spaceB, member, SYSTEM_ID)).scope).toBe("org");
    const spaceRow = await connect(spaceA, member, spaceClientA);
    expect(spaceRow.scope).toBe("space");
    expect((await connect(spaceA, { type: "end_user", id: endUser.id }, SYSTEM_ID)).scope).toBe(
      "space",
    );
    const promoted = await connect(spaceB, member, spaceClientB);
    expect(await scopeViolations()).toEqual([]);

    await promoteIntegrationOAuthClient(spaceB, INTEGRATION, spaceClientB);
    const [widened] = await db.select().from(ic).where(eq(ic.id, promoted.id));
    expect(widened).toMatchObject({ spaceId: null, originSpaceId: spaceB.spaceId });
    expect(await scopeViolations()).toEqual([]);

    const reconnected = await connect(spaceA, member, SYSTEM_ID, spaceRow.id);
    expect(reconnected).toMatchObject({ scope: "org", space_id: null });
    const [reconnectedRow] = await db.select().from(ic).where(eq(ic.id, reconnected.id));
    expect(reconnectedRow).toMatchObject({ originSpaceId: spaceA.spaceId });
    expect(await scopeViolations()).toEqual([]);
  });

  it("refuses to narrow an org row to a space client on reconnect", async () => {
    const orgRow = await connect(spaceA, member, SYSTEM_ID);
    const spaceClientA = await seedClient(spaceA.spaceId, "space-a");

    await expect(connect(spaceA, member, spaceClientA, orgRow.id)).rejects.toMatchObject({
      status: 409,
      code: "connection_scope_narrowing",
    });
    const [row] = await db.select().from(ic).where(eq(ic.id, orgRow.id));
    expect(row).toMatchObject({ spaceId: null, clientRef: SYSTEM_ID });
  });
});
