// SPDX-License-Identifier: Apache-2.0

/**
 * `connection_calls` holds the principal kinds `Actor` admits: `actor_type` is
 * `user` or `end_user`, `owner_type` the same or NULL (the connection was gone
 * at call time).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { connectionCalls } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

async function refusal(promise: Promise<unknown>): Promise<string> {
  const caught = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught, "the statement was expected to be refused by the database").toBeDefined();
  const cause = (caught as { cause?: { message?: string } }).cause;
  return String(cause?.message ?? caught);
}

describe("connection_calls — principal kinds", () => {
  let ctx: TestContext;
  const call = (fields: { actorType?: string; ownerType?: string | null }) =>
    db.insert(connectionCalls).values({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      connectionId: crypto.randomUUID(),
      integrationId: "@test/integration",
      ownerType: fields.ownerType === undefined ? "user" : fields.ownerType,
      ownerId: fields.ownerType === null ? null : ctx.user.id,
      actorType: fields.actorType ?? "user",
      actorId: ctx.user.id,
      authMethod: "session",
      method: "GET",
      host: "api.example.com",
      outcome: "200",
      durationMs: 12,
      requestId: "req_test",
    });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "callkinds" });
  });

  it("accepts both principal kinds, and no owner once the connection is gone", async () => {
    await call({ actorType: "user", ownerType: "user" });
    await call({ actorType: "end_user", ownerType: "end_user" });
    await call({ ownerType: null });
  });

  it("refuses an actor_type outside user / end_user", async () => {
    expect(await refusal(call({ actorType: "api_key" }))).toContain(
      "connection_calls_actor_type_valid",
    );
  });

  it("refuses an owner_type outside user / end_user", async () => {
    expect(await refusal(call({ ownerType: "org" }))).toContain(
      "connection_calls_owner_type_valid",
    );
  });
});
