// SPDX-License-Identifier: Apache-2.0

/**
 * The session-create hook denormalizes `user.realm` onto every session row.
 * A session whose user row is missing must be refused, never created with a
 * default realm.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getAuth } from "@appstrate/db/auth";
import { getTestApp } from "../../helpers/app.ts";
import { createTestUser } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";

getTestApp();

function sessionCreateBefore() {
  const before = getAuth().options.databaseHooks!.session!.create!.before!;
  return before;
}

function sessionFor(userId: string) {
  return {
    id: "s1",
    userId,
    token: "t",
    expiresAt: new Date(Date.now() + 1_000_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("session create hook — realm", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("refuses to create a session for a user with no row", async () => {
    await expect(
      sessionCreateBefore()(sessionFor("usr_missing") as never, null as never),
    ).rejects.toThrow(/no user row for session user usr_missing/);
  });

  it("denormalizes the user's realm onto the session", async () => {
    const { id } = await createTestUser();
    const result = await sessionCreateBefore()(sessionFor(id) as never, null as never);
    expect(result).toEqual({ data: { realm: "platform" } });
  });

  it("reads the realm through Better Auth's adapter inside a request", async () => {
    const { id } = await createTestUser();
    const { adapter } = await getAuth().$context;
    const context = { context: { adapter } };
    expect(await sessionCreateBefore()(sessionFor(id) as never, context as never)).toEqual({
      data: { realm: "platform" },
    });
    await expect(
      sessionCreateBefore()(sessionFor("usr_missing") as never, context as never),
    ).rejects.toThrow(/no user row for session user usr_missing/);
  });
});
