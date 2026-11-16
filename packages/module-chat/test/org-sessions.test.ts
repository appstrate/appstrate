// SPDX-License-Identifier: Apache-2.0

/**
 * Chat sessions, served at `/api/orgs/:orgId/chat/*`: the one kind of conversation.
 *
 * A conversation belongs to the organization and its author, with no owning space. The
 * spaces it touched (`chat_session_spaces`) filter it (`?spaceId=`), and its author
 * opens it only while they reach every one of them with `chat:read`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { chatSessions, chatSessionSpaces, spaces } from "@appstrate/db/schema";
import { getTestApp } from "../../../apps/api/test/helpers/app.ts";
import { truncateAll } from "../../../apps/api/test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  orgOnlyHeaders,
  memberContext,
  memberHolding,
  type TestContext,
} from "../../../apps/api/test/helpers/auth.ts";
import { seedApiKey, seedEndUser, seedSpace } from "../../../apps/api/test/helpers/seed.ts";
import { ensureSession } from "../src/persistence.ts";

const app = getTestApp();

const JSON_HEADERS = { "Content-Type": "application/json" };

interface SessionDto {
  id: string;
  space_ids: string[];
  title: string | null;
}

function orgCall(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/orgs/${ctx.orgId}/chat${path}`, {
    ...init,
    headers: { ...orgOnlyHeaders(ctx), ...JSON_HEADERS },
  });
}

async function createSession(
  ctx: TestContext,
  body: { title?: string; spaceId?: string } = {},
): Promise<SessionDto> {
  const res = await orgCall(ctx, "/sessions", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json()) as SessionDto;
}

async function listSessionIds(ctx: TestContext, query = ""): Promise<string[]> {
  const res = await orgCall(ctx, `/sessions${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SessionDto[] }).data.map((s) => s.id);
}

const touch = (sessionId: string, spaceId: string) =>
  db.insert(chatSessionSpaces).values({ sessionId, spaceId });

const touchedBy = async (sessionId: string): Promise<string[]> =>
  (
    await db
      .select({ spaceId: chatSessionSpaces.spaceId })
      .from(chatSessionSpaces)
      .where(eq(chatSessionSpaces.sessionId, sessionId))
  )
    .map((row) => row.spaceId)
    .sort();

describe("chat sessions", () => {
  let ctx: TestContext;
  let spaceB: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgchat" });
    spaceB = (await seedSpace({ orgId: ctx.orgId, name: "Space B" })).id;
  });

  it("creates, reads, renames, marks read and deletes a conversation", async () => {
    const created = await createSession(ctx, { title: "Overview" });
    expect(created).not.toHaveProperty("spaceId");
    expect(created.space_ids).toEqual([]);

    const got = await orgCall(ctx, `/sessions/${created.id}`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as SessionDto & { messages: unknown[] };
    expect(body.messages).toEqual([]);

    const renamed = await orgCall(ctx, `/sessions/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(renamed.status).toBe(204);
    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, created.id));
    expect(row!.title).toBe("Renamed");

    expect((await orgCall(ctx, `/sessions/${created.id}/read`, { method: "PUT" })).status).toBe(
      204,
    );
    expect((await orgCall(ctx, `/sessions/${created.id}/stream`)).status).toBe(204);
    expect((await orgCall(ctx, `/sessions/${created.id}/stop`, { method: "POST" })).status).toBe(
      204,
    );

    expect((await orgCall(ctx, `/sessions/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await orgCall(ctx, `/sessions/${created.id}`)).status).toBe(404);
  });

  it("keeps a conversation personal to its author", async () => {
    const mine = await createSession(ctx);
    const other = await memberContext(ctx, "member", "operator");
    expect((await orgCall(other, `/sessions/${mine.id}`)).status).toBe(404);
    expect(await listSessionIds(other)).not.toContain(mine.id);
    expect((await orgCall(other, `/sessions/${mine.id}`, { method: "DELETE" })).status).toBe(404);
  });

  describe("creating with the space the user is looking at", () => {
    it("touches it at creation, so the conversation is listed in that space before anything else", async () => {
      const created = await createSession(ctx, { spaceId: spaceB });
      expect(created.space_ids).toEqual([spaceB]);
      expect(await touchedBy(created.id)).toEqual([spaceB]);
      expect(await listSessionIds(ctx, `?spaceId=${spaceB}`)).toEqual([created.id]);
      expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([]);
    });

    it("touches nothing from the overview", async () => {
      const created = await createSession(ctx);
      expect(created.space_ids).toEqual([]);
      expect(await touchedBy(created.id)).toEqual([]);
      expect(await listSessionIds(ctx)).toEqual([created.id]);
    });

    it("refuses a space outside the acting set with a 400 naming spaceId, and creates nothing", async () => {
      const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" }))
        .id;
      const member = await memberContext(ctx, "member", "operator");
      const unknown = await orgCall(member, "/sessions", {
        method: "POST",
        body: JSON.stringify({ spaceId: "spc_00000000-0000-4000-8000-000000000000" }),
      });
      expect(unknown.status).toBe(400);
      const refused = await orgCall(member, "/sessions", {
        method: "POST",
        body: JSON.stringify({ spaceId: closed }),
      });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain("spaceId");
      expect(await db.select().from(chatSessions)).toEqual([]);
    });
  });

  describe("GET …/sessions?spaceId=", () => {
    it("lists the conversations that touched the space, whatever else they touched", async () => {
      const a = await createSession(ctx, { spaceId: ctx.defaultSpaceId });
      const b = await createSession(ctx, { spaceId: spaceB });
      const both = await createSession(ctx, { spaceId: spaceB });
      await touch(both.id, ctx.defaultSpaceId);
      const overview = await createSession(ctx);

      expect(new Set(await listSessionIds(ctx))).toEqual(
        new Set([a.id, b.id, both.id, overview.id]),
      );
      expect(new Set(await listSessionIds(ctx, `?spaceId=${spaceB}`))).toEqual(
        new Set([b.id, both.id]),
      );
      expect(new Set(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`))).toEqual(
        new Set([a.id, both.id]),
      );
      const dto = (await (await orgCall(ctx, `/sessions/${both.id}`)).json()) as SessionDto;
      expect([...dto.space_ids].sort()).toEqual([ctx.defaultSpaceId, spaceB].sort());
    });

    it("pages within the filtered set: the cursor is valid there only", async () => {
      const inB = [
        await createSession(ctx, { title: "one", spaceId: spaceB }),
        await createSession(ctx, { title: "two", spaceId: spaceB }),
        await createSession(ctx, { title: "three", spaceId: spaceB }),
      ];
      const elsewhere = await createSession(ctx, { title: "four", spaceId: ctx.defaultSpaceId });
      const base = Date.now();
      for (const [i, s] of [...inB, elsewhere].entries()) {
        await db
          .update(chatSessions)
          .set({ updatedAt: new Date(base + i * 1000) })
          .where(eq(chatSessions.id, s.id));
      }
      const newestFirst = inB.map((s) => s.id).reverse();
      const filter = `spaceId=${spaceB}`;

      expect(await listSessionIds(ctx, `?${filter}&limit=2`)).toEqual(newestFirst.slice(0, 2));
      expect(
        await listSessionIds(ctx, `?${filter}&limit=2&startingAfter=${newestFirst[1]}`),
      ).toEqual([newestFirst[2]!]);
      expect(await listSessionIds(ctx, `?${filter}&q=tw`)).toEqual([inB[1]!.id]);
      // A session of the unfiltered list that did not touch the space is not a cursor there.
      const bad = await orgCall(ctx, `/sessions?${filter}&startingAfter=${elsewhere.id}`);
      expect(bad.status).toBe(400);
      expect(await listSessionIds(ctx, `?startingAfter=${elsewhere.id}&limit=1`)).toHaveLength(1);
    });

    it("refuses a space the caller cannot read chats in, like any bad filter value", async () => {
      const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" }))
        .id;
      const member = await memberContext(ctx, "member", "operator");
      const res = await orgCall(member, `/sessions?spaceId=${closed}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("spaceId");
      expect((await orgCall(member, "/sessions?spaceId=spc_nope")).status).toBe(400);
    });
  });

  it("lists a conversation by what it touched: a space the reader cannot read hides it everywhere", async () => {
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" })).id;
    const member = await memberContext(ctx, "member", "operator");
    const session = await createSession(member, { title: "Cross" });
    await touch(session.id, ctx.defaultSpaceId);
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(200);
    expect(await listSessionIds(member)).toContain(session.id);
    const dto = (await (await orgCall(member, `/sessions/${session.id}`)).json()) as SessionDto;
    expect(dto.space_ids).toEqual([ctx.defaultSpaceId]);

    // A touched space the member does not reach hides the session everywhere.
    await touch(session.id, closed);
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(404);
    expect((await orgCall(member, `/sessions/${session.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect((await orgCall(member, `/sessions/${session.id}/stream`)).status).toBe(204);
    expect(await listSessionIds(member)).not.toContain(session.id);

    // The space going away drops it from the record (cascade): visible again.
    await db.delete(spaces).where(eq(spaces.id, closed));
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(200);
    expect(await listSessionIds(member)).toContain(session.id);
  });

  it("excludes a conversation whose touched space the role cannot read chats in", async () => {
    const noChat = await memberHolding(ctx, ["agents:read"]);
    await db.insert(chatSessions).values({
      id: "chs_hidden_by_role",
      orgId: ctx.orgId,
      userId: noChat.user.id,
    });
    await touch("chs_hidden_by_role", ctx.defaultSpaceId);
    const reachable = await createSession(noChat, { spaceId: spaceB });
    expect(await listSessionIds(noChat)).toEqual([reachable.id]);
  });

  it("pages with a cursor that must be a listed session", async () => {
    const sessions = [
      await createSession(ctx, { title: "one" }),
      await createSession(ctx, { title: "two" }),
      await createSession(ctx, { title: "three" }),
    ];
    const base = Date.now();
    for (const [i, s] of sessions.entries()) {
      await db
        .update(chatSessions)
        .set({ updatedAt: new Date(base + i * 1000) })
        .where(eq(chatSessions.id, s.id));
    }
    const newestFirst = sessions.map((s) => s.id).reverse();

    expect(await listSessionIds(ctx, "?limit=2")).toEqual(newestFirst.slice(0, 2));
    expect(await listSessionIds(ctx, `?limit=2&startingAfter=${newestFirst[1]}`)).toEqual([
      newestFirst[2]!,
    ]);
    expect(await listSessionIds(ctx, "?q=tw")).toEqual([sessions[1]!.id]);

    // Someone else's session is not a cursor.
    const other = await memberContext(ctx, "member", "operator");
    const theirs = await createSession(other);
    const bad = await orgCall(ctx, `/sessions?startingAfter=${theirs.id}`);
    expect(bad.status).toBe(400);
  });

  it("ignores X-Space-Id like every organization route, and refuses another organization's path with a 403", async () => {
    // The MCP router sets `x-space-id` on every dispatched hop: a route that refused it would
    // be unreachable through `invoke_operation`.
    const withHeader = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      headers: authHeaders(ctx),
    });
    expect(withHeader.status).toBe(200);

    const otherOrg = await createTestContext({ orgSlug: "otherchat" });
    const foreign = await app.request(`/api/orgs/${otherOrg.orgId}/chat/sessions`, {
      headers: orgOnlyHeaders(ctx),
    });
    expect(foreign.status).toBe(403);
  });

  describe("POST /api/orgs/{orgId}/chat", () => {
    const turn = (caller: TestContext, headers = orgOnlyHeaders(caller)) =>
      app.request(`/api/orgs/${caller.orgId}/chat`, {
        method: "POST",
        headers: { ...headers, ...JSON_HEADERS },
        body: JSON.stringify({
          id: "chs_org_turn_admission",
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "salut" }] }],
        }),
      });

    it("is admitted by an acting space only, and refuses another organization", async () => {
      // A caller whose one space grants chat:read alone holds chat:write nowhere.
      const readerOrg = await createTestContext({ orgSlug: "readerorg" });
      const reader = await memberHolding(readerOrg, ["chat:read"]);
      expect((await turn(reader)).status).toBe(403);

      // chat:write and chat:read without mcp:read: the turn could name no space, so none acts.
      const noToolsOrg = await createTestContext({ orgSlug: "notoolsorg" });
      const noTools = await memberHolding(noToolsOrg, ["chat:read", "chat:write"]);
      const refused = await turn(noTools);
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { detail: string }).detail).toContain("mcp:read");

      const otherOrg = await createTestContext({ orgSlug: "otherturn" });
      const foreign = await app.request(`/api/orgs/${otherOrg.orgId}/chat`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(ctx), ...JSON_HEADERS },
        body: "{}",
      });
      expect(foreign.status).toBe(403);
    });
  });

  it("refuses a credential pinned to a space, whatever it grants", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["chat:read", "chat:write", "mcp:read"],
    });
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { detail: string }).detail).toContain("pinned");
  });

  it("refuses an API key", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["runs:read-all"],
    });
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an end-user", async () => {
    const key = await seedApiKey({
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      scopes: ["runs:read-all"],
    });
    const endUser = await seedEndUser({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId });
    const res = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      headers: { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id },
    });
    expect(res.status).toBe(403);
  });
});

describe("ensureSession", () => {
  it("opens an existing conversation only while every touched space is readable", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensurevisible" });
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    await ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, []);
    await touch("chs_org_visible", other);

    await expect(
      ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, [ctx.defaultSpaceId]),
    ).rejects.toMatchObject({ status: 404 });
    await ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, [ctx.defaultSpaceId, other]);
  });

  it("refuses a session id that belongs to another author, and touches nothing for them", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensureowner" });
    const stranger = await memberContext(ctx, "member", "operator");
    await ensureSession("chs_owned", ctx.orgId, ctx.user.id, []);
    await expect(
      ensureSession("chs_owned", ctx.orgId, stranger.user.id, [], undefined, ctx.defaultSpaceId),
    ).rejects.toMatchObject({ status: 404 });
    expect(await touchedBy("chs_owned")).toEqual([]);
  });

  it("touches the space the user is looking at: at creation, and on an existing conversation", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensuretouch" });
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    const readable = [ctx.defaultSpaceId, other];

    // A new conversation touches it in the same transaction as its insert.
    await ensureSession("chs_touch", ctx.orgId, ctx.user.id, readable, undefined, other);
    expect(await touchedBy("chs_touch")).toEqual([other]);
    // The same space again is idempotent; a space it never touched is brought in.
    await ensureSession("chs_touch", ctx.orgId, ctx.user.id, readable, undefined, other);
    await ensureSession(
      "chs_touch",
      ctx.orgId,
      ctx.user.id,
      readable,
      undefined,
      ctx.defaultSpaceId,
    );
    expect(await touchedBy("chs_touch")).toEqual([ctx.defaultSpaceId, other].sort());
    // Without a space (the overview) nothing is touched.
    await ensureSession("chs_overview", ctx.orgId, ctx.user.id, readable);
    expect(await touchedBy("chs_overview")).toEqual([]);
  });
});
