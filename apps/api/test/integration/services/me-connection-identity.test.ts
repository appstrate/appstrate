// SPDX-License-Identifier: Apache-2.0

/**
 * The `identity` of a `/api/me/connections` entry: the identity claim when one exists, else the
 * account id, else the label. The placeholder account id of an identity-less connection is never shown.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { testCaller } from "../../helpers/connection-shares.ts";
import { listMeConnections } from "../../../src/services/me-connections.ts";
import type { ConnectionCaller } from "../../../src/services/connection-reach.ts";

const INTEGRATION = "@identity/svc";
const AUTH = "google";

describe("listMeConnections — identity", () => {
  let ctx: TestContext;
  let caller: ConnectionCaller;

  async function identityOf(id: string): Promise<string | undefined> {
    const groups = await listMeConnections(caller);
    return groups.flatMap((g) => g.connections).find((e) => e.connection_id === id)?.identity;
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "identityorg" });
    caller = testCaller({ kind: "person", actor: { type: "user", id: ctx.user.id } });
    await seedPackage({
      id: INTEGRATION,
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      type: "integration",
      source: "local",
    });
  });

  async function seedConnection(accountId: string, label: string): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: AUTH,
        accountId,
        orgId: ctx.orgId,
        spaceId: null,
        originSpaceId: null,
        userId: ctx.user.id,
        credentialsEncrypted: "x",
        scopesGranted: [],
        label,
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  it("shows the label of an identity-less connection, never the placeholder account id", async () => {
    const id = await seedConnection("default", "Connexion 1");
    expect(await identityOf(id)).toBe("Connexion 1");
  });

  it("shows the account id of a connection whose identity claims are absent", async () => {
    const id = await seedConnection("acct-42", "Connexion 2");
    expect(await identityOf(id)).toBe("acct-42");
  });
});
