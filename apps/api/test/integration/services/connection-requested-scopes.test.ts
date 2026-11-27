// SPDX-License-Identifier: Apache-2.0

/**
 * A connection's step-up demand: the scopes a server asked for that it does not hold. One writer
 * (`recordRequestedScopes`, behind its reach, OAuth2 only), cleared by the credential write that grants them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections, notifications } from "@appstrate/db/schema";
import type { Actor } from "@appstrate/connect";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { settle, until } from "../../helpers/credential-death-spy.ts";
import {
  recordRequestedScopes,
  saveIntegrationConnection,
} from "../../../src/services/integration-connections.ts";
import type { SpaceScope } from "../../../src/lib/scope.ts";

const INTEGRATION = "@orga/mail";

describe("connection requested scopes", () => {
  let ctx: TestContext;
  let scope: SpaceScope;
  let actor: Actor;
  let connectionId: string;
  let reach: { spaceId: string; actor: Actor };

  const requested = async (id = connectionId) =>
    (
      await db
        .select({ requested: integrationConnections.requestedScopes })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, id))
    )[0]!.requested;

  const save = (scopesGranted: string[], id?: string) =>
    saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "tok" },
      identityClaims: { email: "alice@example.com" },
      scopesGranted,
      clientRef: "test-client",
      actor,
      connectionId: id,
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reqscopes" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };
    reach = { spaceId: ctx.defaultSpaceId, actor };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    connectionId = (await save(["read"])).id;
  });

  it("keeps the valid scopes the connection does not hold, once each", async () => {
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["read", "write", "bad scope"]);
    expect(await requested()).toEqual(["write"]);
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    expect(await requested()).toEqual(["write", "admin"]);
  });

  it("is bounded", async () => {
    for (let i = 0; i < 4; i++) {
      await recordRequestedScopes(
        connectionId,
        INTEGRATION,
        reach,
        Array.from({ length: 20 }, (_, j) => `s${i}_${j}`),
      );
    }
    expect((await requested()).length).toBe(20);
  });

  it("records nothing for a caller that does not reach the connection", async () => {
    const other = await memberContext(ctx, "member");
    const unreached = await recordRequestedScopes(
      connectionId,
      INTEGRATION,
      { spaceId: ctx.defaultSpaceId, actor: { type: "user", id: other.user.id } },
      ["write"],
    );
    expect(unreached).toBeNull();
    expect(await requested()).toEqual([]);
  });

  it("records nothing on a connection no consent grants scopes to (no minting client)", async () => {
    const keyed = await saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "key",
      accountId: "key-account",
      credentials: { api_key: "k" },
      actor,
    });
    expect(await recordRequestedScopes(keyed.id, INTEGRATION, reach, ["write"])).toBeNull();
    expect(await requested(keyed.id)).toEqual([]);
  });

  it("is cleared by the reconnect that grants the scopes, and only by it", async () => {
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    await save(["read", "write"], connectionId);
    expect(await requested()).toEqual(["admin"]);
    await save(["read", "write", "admin"], connectionId);
    expect(await requested()).toEqual([]);
  });

  describe("the owner's notice", () => {
    const notices = () =>
      db
        .select({
          recipientId: notifications.recipientId,
          spaceId: notifications.spaceId,
          payload: notifications.payload,
          readAt: notifications.readAt,
        })
        .from(notifications)
        .where(eq(notifications.type, "connection_scopes_requested"));

    it("tells the owner once a demand gains a scope, one unread notice per connection", async () => {
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write"]);
      await until(async () => (await notices()).length === 1);
      expect(await notices()).toEqual([
        {
          recipientId: ctx.user.id,
          spaceId: ctx.defaultSpaceId,
          payload: {
            packageId: INTEGRATION,
            integration_name: INTEGRATION,
            connection_id: connectionId,
            label: expect.any(String),
          },
          readAt: null,
        },
      ]);
      // A wider demand while the notice is unread stacks nothing.
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["admin"]);
      await settle();
      expect(await notices()).toHaveLength(1);
      // Read, then asked again for a new scope: a new notice.
      await db.update(notifications).set({ readAt: new Date() });
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["delete"]);
      await until(async () => (await notices()).length === 2);
      // Read again, then asked only for scopes it already demands or holds: nothing new to say.
      await db.update(notifications).set({ readAt: new Date() });
      await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "read", "bad scope"]);
      await settle();
      expect(await notices()).toHaveLength(2);
    });
  });
});
