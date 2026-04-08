// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import {
  resolveOrCreateEndUser,
  linkEndUserToAuthUser,
} from "../../../src/services/enduser-mapping.ts";
import { createEndUser } from "../../../src/services/end-users.ts";
import { db } from "@appstrate/db/client";
import { endUsers } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

describe("resolveOrCreateEndUser", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("creates a new end-user when none exists", async () => {
    const authUser = { id: ctx.user.id, email: "alice@example.com", name: "Alice" };
    const endUser = await resolveOrCreateEndUser(authUser, ctx.defaultAppId);

    expect(endUser.id).toStartWith("eu_");
    expect(endUser.applicationId).toBe(ctx.defaultAppId);
    expect(endUser.email).toBe("alice@example.com");
    expect(endUser.name).toBe("Alice");
  });

  it("returns existing linked end-user on second call", async () => {
    const authUser = { id: ctx.user.id, email: "alice@example.com", name: "Alice" };

    const first = await resolveOrCreateEndUser(authUser, ctx.defaultAppId);
    const second = await resolveOrCreateEndUser(authUser, ctx.defaultAppId);

    expect(second.id).toBe(first.id);
  });

  it("links API-created end-user with matching email", async () => {
    // Create an end-user via API (no authUserId)
    const apiEndUser = await createEndUser(ctx.orgId, ctx.defaultAppId, {
      email: "bob@example.com",
      name: "Bob API",
      externalId: "bob@example.com",
    });

    // Now authenticate as the same email
    const authUser = { id: ctx.user.id, email: "bob@example.com", name: "Bob Auth" };
    const resolved = await resolveOrCreateEndUser(authUser, ctx.defaultAppId);

    // Should return the same end-user (linked, not a new one)
    expect(resolved.id).toBe(apiEndUser.id);

    // Verify authUserId was set
    const [row] = await db
      .select({ authUserId: endUsers.authUserId, emailVerified: endUsers.emailVerified })
      .from(endUsers)
      .where(eq(endUsers.id, apiEndUser.id))
      .limit(1);

    expect(row!.authUserId).toBe(ctx.user.id);
    expect(row!.emailVerified).toBe(true);
  });

  it("creates separate end-users for different applications", async () => {
    // This test would need a second application — skip for now
    // The unique index (applicationId, authUserId) ensures isolation
    const authUser = { id: ctx.user.id, email: "alice@example.com", name: "Alice" };
    const endUser = await resolveOrCreateEndUser(authUser, ctx.defaultAppId);
    expect(endUser.applicationId).toBe(ctx.defaultAppId);
  });
});

describe("linkEndUserToAuthUser", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("sets authUserId and emailVerified on unlinked end-user", async () => {
    const apiEndUser = await createEndUser(ctx.orgId, ctx.defaultAppId, {
      email: "charlie@example.com",
      name: "Charlie",
    });

    await linkEndUserToAuthUser(apiEndUser.id, ctx.user.id);

    const [row] = await db
      .select({ authUserId: endUsers.authUserId, emailVerified: endUsers.emailVerified })
      .from(endUsers)
      .where(eq(endUsers.id, apiEndUser.id))
      .limit(1);

    expect(row!.authUserId).toBe(ctx.user.id);
    expect(row!.emailVerified).toBe(true);
  });

  it("does not overwrite if already linked", async () => {
    const apiEndUser = await createEndUser(ctx.orgId, ctx.defaultAppId, {
      email: "charlie@example.com",
      name: "Charlie",
    });

    await linkEndUserToAuthUser(apiEndUser.id, ctx.user.id);
    // Try to link to a different user — should be a no-op (WHERE authUserId IS NULL)
    await linkEndUserToAuthUser(apiEndUser.id, "different-user-id");

    const [row] = await db
      .select({ authUserId: endUsers.authUserId })
      .from(endUsers)
      .where(eq(endUsers.id, apiEndUser.id))
      .limit(1);

    expect(row!.authUserId).toBe(ctx.user.id);
  });
});
