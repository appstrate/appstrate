// SPDX-License-Identifier: Apache-2.0

/**
 * `recordConnectionCall` — the single writer of the credential proxy's call journal.
 *
 * Pins what the proxy depends on: one row per call with the caller's values, the connection's
 * owner looked up at call time, the target kept as its template, and a writer that never throws.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { connectionCalls, integrationConnections } from "@appstrate/db/schema";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedEndUser, seedPackage } from "../../helpers/seed.ts";
import { recordConnectionCall } from "../../../src/services/credential-proxy/call-journal.ts";

const INTEGRATION = "@journal/crm";

describe("recordConnectionCall", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "journal" });
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  async function seedConnection(owner: { userId?: string; endUserId?: string }): Promise<string> {
    const [row] = await db
      .insert(integrationConnections)
      .values({
        integrationId: INTEGRATION,
        authKey: "primary",
        accountId: `acct-${crypto.randomUUID().slice(0, 8)}`,
        label: `Connexion ${crypto.randomUUID().slice(0, 8)}`,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: owner.userId ?? null,
        endUserId: owner.endUserId ?? null,
        credentialsEncrypted: "x",
        scopesGranted: [],
      })
      .returning({ id: integrationConnections.id });
    return row!.id;
  }

  function call(
    connectionId: string,
    overrides: Partial<Parameters<typeof recordConnectionCall>[0]> = {},
  ) {
    return recordConnectionCall({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId,
      integrationId: INTEGRATION,
      actor: { type: "user", id: ctx.user.id },
      apiKeyId: null,
      authMethod: "session",
      runId: null,
      method: "GET",
      target: "https://api.example.com/v1/users",
      outcome: "200",
      durationMs: 12,
      requestId: "req_1",
      ...overrides,
    });
  }

  function rows() {
    return db.select().from(connectionCalls).orderBy(connectionCalls.id);
  }

  it("writes one row carrying every value of the call", async () => {
    const connectionId = await seedConnection({ userId: ctx.user.id });

    await call(connectionId, {
      actor: { type: "end_user", id: "eu_actor" },
      apiKeyId: "key_1",
      authMethod: "api_key",
      runId: "run_1",
      method: "post",
      outcome: "upstream_timeout",
      durationMs: 1234.6,
      requestId: "req_42",
    });

    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId,
      integrationId: INTEGRATION,
      ownerType: "user",
      ownerId: ctx.user.id,
      actorType: "end_user",
      actorId: "eu_actor",
      apiKeyId: "key_1",
      authMethod: "api_key",
      runId: "run_1",
      method: "POST",
      host: "api.example.com",
      path: "/v1/users",
      outcome: "upstream_timeout",
      durationMs: 1235,
      requestId: "req_42",
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("names an end-user owner", async () => {
    const endUser = await seedEndUser({ spaceId: ctx.defaultSpaceId, orgId: ctx.orgId });
    const connectionId = await seedConnection({ endUserId: endUser.id });

    await call(connectionId);

    const [row] = await rows();
    expect(row).toMatchObject({ ownerType: "end_user", ownerId: endUser.id });
  });

  it("records a call whose connection is gone, with no owner", async () => {
    await call(crypto.randomUUID());

    const [row] = await rows();
    expect(row).toMatchObject({ ownerType: null, ownerId: null, outcome: "200" });
  });

  it("stores the target as its template: no query string, no substituted value", async () => {
    const connectionId = await seedConnection({ userId: ctx.user.id });

    await call(connectionId, {
      target: "https://{{subdomain}}.example.com/v1/{{account}}/items?api_key={{api_key}}&q=1",
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      host: "{{subdomain}}.example.com",
      path: "/v1/{{account}}/items",
    });
  });

  it("caps the host and the path it stores", async () => {
    const connectionId = await seedConnection({ userId: ctx.user.id });
    const labels = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(60));

    await call(connectionId, { target: `https://${labels.join(".")}/${"p".repeat(5000)}` });

    const [row] = await rows();
    expect(row!.host).toHaveLength(255);
    expect(row!.path).toHaveLength(2048);
  });

  it("keeps the row when the connection is deleted afterwards", async () => {
    const connectionId = await seedConnection({ userId: ctx.user.id });
    await call(connectionId);

    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));

    const [row] = await rows();
    expect(row).toMatchObject({ connectionId, ownerType: "user", ownerId: ctx.user.id });
  });

  it("never throws: a call the database refuses is dropped", async () => {
    // Neither id is a UUID, so the owner lookup and the insert both fail.
    await expect(call("not-a-uuid", { orgId: "not-a-uuid" })).resolves.toBeUndefined();
    const connectionId = await seedConnection({ userId: ctx.user.id });
    await expect(call(connectionId, { orgId: "not-a-uuid" })).resolves.toBeUndefined();

    expect(await rows()).toHaveLength(0);
  });
});
