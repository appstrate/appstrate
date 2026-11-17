// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation's origin space is not an owner: deleting the space detaches it, and deleting
 * the organization deletes it with every space, a limited conversation included (its CHECK
 * `chat_sessions_restricted_needs_space` must never be hit by a delete).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessionSpaces, chatSessions, organizations, spaces } from "@appstrate/db/schema";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { deleteOrganization } from "../../../src/services/organizations.ts";
import { createSpace, deleteSpace } from "../../../src/services/spaces.ts";

describe("deleting a conversation's origin space or its organization", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "chat-origin-delete" });
  });

  async function seedLimitedConversation(originId: string): Promise<string> {
    const sessionId = `chs_${crypto.randomUUID()}`;
    await db.insert(chatSessions).values({
      id: sessionId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      spaceId: originId,
      restricted: true,
    });
    await db
      .insert(chatSessionSpaces)
      .values({ sessionId, spaceId: ctx.defaultSpaceId, orgId: ctx.orgId });
    return sessionId;
  }

  it("deleting the organization deletes a limited conversation with its spaces", async () => {
    const origin = await createSpace(ctx.orgId, { name: "Origin" }, ctx.user.id);
    const sessionId = await seedLimitedConversation(origin.id);

    await deleteOrganization(ctx.orgId);

    expect(await db.select().from(organizations).where(eq(organizations.id, ctx.orgId))).toEqual(
      [],
    );
    expect(await db.select().from(spaces).where(eq(spaces.orgId, ctx.orgId))).toEqual([]);
    expect(await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId))).toEqual([]);
    expect(
      await db.select().from(chatSessionSpaces).where(eq(chatSessionSpaces.sessionId, sessionId)),
    ).toEqual([]);
  });

  it("deleting the origin space detaches a limited conversation and lifts its limit", async () => {
    const origin = await createSpace(ctx.orgId, { name: "Origin" }, ctx.user.id);
    const sessionId = await seedLimitedConversation(origin.id);

    await deleteSpace(ctx.orgId, origin.id);

    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(session).toMatchObject({ spaceId: null, restricted: false });
    expect(
      await db
        .select({ spaceId: chatSessionSpaces.spaceId })
        .from(chatSessionSpaces)
        .where(eq(chatSessionSpaces.sessionId, sessionId)),
    ).toEqual([{ spaceId: ctx.defaultSpaceId }]);
  });

  it("a delete of the origin space that does not detach first is refused, never half-applied", async () => {
    const origin = await createSpace(ctx.orgId, { name: "Origin" }, ctx.user.id);
    const sessionId = await seedLimitedConversation(origin.id);

    await expect(db.delete(spaces).where(eq(spaces.id, origin.id)).execute()).rejects.toThrow();

    const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect(session).toMatchObject({ spaceId: origin.id, restricted: true });
  });
});
