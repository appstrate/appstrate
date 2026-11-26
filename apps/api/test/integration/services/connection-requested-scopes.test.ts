// SPDX-License-Identifier: Apache-2.0

/**
 * A connection's step-up demand: the scopes a server asked for that it does not hold. One writer
 * (`recordRequestedScopes`, behind its reach), cleared by the credential write that grants them.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@appstrate/db/schema";
import type { Actor } from "@appstrate/connect";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
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

  const requested = async () =>
    (
      await db
        .select({ requested: integrationConnections.requestedScopes })
        .from(integrationConnections)
        .where(eq(integrationConnections.id, connectionId))
    )[0]!.requested;

  const grant = (scopesGranted: string[]) =>
    saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "tok" },
      identityClaims: { email: "alice@example.com" },
      scopesGranted,
      actor,
      connectionId,
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "reqscopes" });
    scope = { orgId: ctx.orgId, spaceId: ctx.defaultSpaceId };
    actor = { type: "user", id: ctx.user.id };
    reach = { spaceId: ctx.defaultSpaceId, actor };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
    const created = await saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId: "alice@example.com",
      credentials: { access_token: "tok" },
      identityClaims: { email: "alice@example.com" },
      scopesGranted: ["read"],
      actor,
    });
    connectionId = created.id;
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

  it("is cleared by the reconnect that grants the scopes, and only by it", async () => {
    await recordRequestedScopes(connectionId, INTEGRATION, reach, ["write", "admin"]);
    await grant(["read", "write"]);
    expect(await requested()).toEqual(["admin"]);
    await grant(["read", "write", "admin"]);
    expect(await requested()).toEqual([]);
  });
});
