// SPDX-License-Identifier: Apache-2.0

/**
 * Organization chat sessions (`chat_sessions.space_id IS NULL`), served by the
 * same handlers as the space sessions at `/api/orgs/:orgId/chat/*`.
 *
 * A space session is opened by its space's mount only; an organization session
 * by the organization mount only, and only while its author reaches every space
 * it touched (`chat_session_spaces`) with `chat:read`. The organization list
 * adds the space sessions of every space the reader reaches.
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
  spaceId: string | null;
  space_ids: string[];
  title: string | null;
}

function orgCall(ctx: TestContext, path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(`/api/orgs/${ctx.orgId}/chat${path}`, {
    ...init,
    headers: { ...orgOnlyHeaders(ctx), ...JSON_HEADERS },
  });
}

function spaceCall(
  ctx: TestContext,
  spaceId: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.request(`/api/chat${path}`, {
    ...init,
    headers: { ...authHeaders(ctx, { "X-Space-Id": spaceId }), ...JSON_HEADERS },
  });
}

async function createOrgSession(ctx: TestContext, title?: string): Promise<SessionDto> {
  const res = await orgCall(ctx, "/sessions", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as SessionDto;
}

async function createSpaceSession(
  ctx: TestContext,
  spaceId: string,
  title?: string,
): Promise<SessionDto> {
  const res = await spaceCall(ctx, spaceId, "/sessions", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as SessionDto;
}

async function listOrgSessionIds(ctx: TestContext, query = ""): Promise<string[]> {
  const res = await orgCall(ctx, `/sessions${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: SessionDto[] }).data.map((s) => s.id);
}

const touch = (sessionId: string, spaceId: string) =>
  db.insert(chatSessionSpaces).values({ sessionId, spaceId });

describe("organization chat sessions", () => {
  let ctx: TestContext;
  let spaceB: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "orgchat" });
    spaceB = (await seedSpace({ orgId: ctx.orgId, name: "Space B" })).id;
  });

  it("creates, reads, renames, marks read and deletes an organization session", async () => {
    const created = await createOrgSession(ctx, "Overview");
    expect(created.spaceId).toBeNull();
    expect(created.space_ids).toEqual([]);

    const got = await orgCall(ctx, `/sessions/${created.id}`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as SessionDto & { messages: unknown[] };
    expect(body.spaceId).toBeNull();
    expect(body.messages).toEqual([]);

    const renamed = await orgCall(ctx, `/sessions/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(renamed.status).toBe(204);
    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, created.id));
    expect(row!.title).toBe("Renamed");
    expect(row!.spaceId).toBeNull();

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

  it("serves a space session on its own mount only, and an organization session on the other", async () => {
    const inSpace = await createSpaceSession(ctx, ctx.defaultSpaceId);
    expect(inSpace.spaceId).toBe(ctx.defaultSpaceId);
    expect(inSpace.space_ids).toEqual([]);
    const org = await createOrgSession(ctx);

    expect((await orgCall(ctx, `/sessions/${inSpace.id}`)).status).toBe(404);
    expect(
      (
        await orgCall(ctx, `/sessions/${inSpace.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "x" }),
        })
      ).status,
    ).toBe(404);
    expect((await orgCall(ctx, `/sessions/${inSpace.id}`, { method: "DELETE" })).status).toBe(404);

    expect((await spaceCall(ctx, ctx.defaultSpaceId, `/sessions/${org.id}`)).status).toBe(404);
    expect(
      (await spaceCall(ctx, ctx.defaultSpaceId, `/sessions/${org.id}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    // The space list never carries an organization session.
    const fromSpace = (await (await spaceCall(ctx, ctx.defaultSpaceId, "/sessions")).json()) as {
      data: SessionDto[];
    };
    expect(fromSpace.data.map((s) => s.id)).toEqual([inSpace.id]);
  });

  it("lists the organization sessions and the space sessions of every readable space", async () => {
    const a = await createSpaceSession(ctx, ctx.defaultSpaceId);
    const b = await createSpaceSession(ctx, spaceB);
    const org = await createOrgSession(ctx);
    expect(new Set(await listOrgSessionIds(ctx))).toEqual(new Set([a.id, b.id, org.id]));
  });

  it("excludes the spaces the reader cannot read: closed and not joined, or a role without chat:read", async () => {
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" })).id;
    const owned = await createSpaceSession(ctx, ctx.defaultSpaceId);
    const inClosed = await createSpaceSession(ctx, closed);

    // A member reaches neither the closed space they never joined...
    const member = await memberContext(ctx, "member", "operator");
    const viaMember = await createSpaceSession(member, ctx.defaultSpaceId);
    expect(new Set(await listOrgSessionIds(member))).toEqual(new Set([viaMember.id]));
    expect(await listOrgSessionIds(member)).not.toContain(inClosed.id);
    expect(await listOrgSessionIds(member)).not.toContain(owned.id);

    // ...nor a space where their role lacks chat:read: their own row there is not listed.
    const noChat = await memberHolding(ctx, ["agents:read"]);
    await db.insert(chatSessions).values({
      id: "chs_hidden_by_role",
      orgId: ctx.orgId,
      userId: noChat.user.id,
      spaceId: ctx.defaultSpaceId,
    });
    const reachable = await createSpaceSession(noChat, spaceB);
    expect(await listOrgSessionIds(noChat)).toEqual([reachable.id]);
  });

  it("opens an organization session only while every touched space is readable", async () => {
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" })).id;
    // The owner reaches the closed space as an admin; a demoted view of the same
    // author is modelled with a member who holds a role there and then loses it.
    const member = await memberContext(ctx, "member", "operator");
    const session = await createOrgSession(member, "Cross");
    await touch(session.id, ctx.defaultSpaceId);
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(200);
    expect(await listOrgSessionIds(member)).toContain(session.id);
    const dto = (await (await orgCall(member, `/sessions/${session.id}`)).json()) as SessionDto;
    expect(dto.space_ids).toEqual([ctx.defaultSpaceId]);

    // A touched space the member does not reach hides the session everywhere.
    await touch(session.id, closed);
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(404);
    expect((await orgCall(member, `/sessions/${session.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect((await orgCall(member, `/sessions/${session.id}/stream`)).status).toBe(204);
    expect(await listOrgSessionIds(member)).not.toContain(session.id);

    // The space going away drops it from the record (cascade): visible again.
    await db.delete(spaces).where(eq(spaces.id, closed));
    expect((await orgCall(member, `/sessions/${session.id}`)).status).toBe(200);
    expect(await listOrgSessionIds(member)).toContain(session.id);
  });

  it("pages across both kinds with a cursor that must be a listed session", async () => {
    const sessions = [
      await createSpaceSession(ctx, ctx.defaultSpaceId, "one"),
      await createOrgSession(ctx, "two"),
      await createSpaceSession(ctx, spaceB, "three"),
    ];
    const base = Date.now();
    for (const [i, s] of sessions.entries()) {
      await db
        .update(chatSessions)
        .set({ updatedAt: new Date(base + i * 1000) })
        .where(eq(chatSessions.id, s.id));
    }
    const newestFirst = sessions.map((s) => s.id).reverse();

    expect(await listOrgSessionIds(ctx, "?limit=2")).toEqual(newestFirst.slice(0, 2));
    expect(await listOrgSessionIds(ctx, `?limit=2&startingAfter=${newestFirst[1]}`)).toEqual([
      newestFirst[2]!,
    ]);
    expect(await listOrgSessionIds(ctx, "?q=tw")).toEqual([sessions[1]!.id]);

    // Someone else's session is not a cursor.
    const other = await memberContext(ctx, "member", "operator");
    const theirs = await createOrgSession(other);
    const bad = await orgCall(ctx, `/sessions?startingAfter=${theirs.id}`);
    expect(bad.status).toBe(400);
  });

  it("refuses X-Space-Id with a 400 and another organization's path with a 403", async () => {
    const withHeader = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      headers: authHeaders(ctx),
    });
    expect(withHeader.status).toBe(400);
    const body = (await withHeader.json()) as { param?: string; detail: string };
    expect(body.param).toBe("X-Space-Id");
    expect(body.detail).toContain("/api/chat");

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

    it("is admitted by chat:write in some space only, reads no X-Space-Id, refuses another organization", async () => {
      // A caller whose one space grants chat:read alone holds chat:write nowhere.
      const readerOrg = await createTestContext({ orgSlug: "readerorg" });
      const reader = await memberHolding(readerOrg, ["chat:read"]);
      expect((await turn(reader)).status).toBe(403);

      const withHeader = await turn(ctx, authHeaders(ctx));
      expect(withHeader.status).toBe(400);
      expect(((await withHeader.json()) as { param?: string }).param).toBe("X-Space-Id");

      const otherOrg = await createTestContext({ orgSlug: "otherturn" });
      const foreign = await app.request(`/api/orgs/${otherOrg.orgId}/chat`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(ctx), ...JSON_HEADERS },
        body: "{}",
      });
      expect(foreign.status).toBe(403);
    });
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

describe("ensureSession keeps a session's kind", () => {
  it("opens an existing organization session only while every touched space is readable", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensurevisible" });
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    await ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, { spaceId: null, readable: [] });
    await touch("chs_org_visible", other);

    await expect(
      ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, {
        spaceId: null,
        readable: [ctx.defaultSpaceId],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await ensureSession("chs_org_visible", ctx.orgId, ctx.user.id, {
      spaceId: null,
      readable: [ctx.defaultSpaceId, other],
    });
  });

  it("refuses an organization session id in a space, and a space session id as organization", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensurekind" });

    await ensureSession("chs_org_kind", ctx.orgId, ctx.user.id, { spaceId: null, readable: [] });
    await ensureSession("chs_org_kind", ctx.orgId, ctx.user.id, { spaceId: null, readable: [] });
    await expect(
      ensureSession("chs_org_kind", ctx.orgId, ctx.user.id, { spaceId: ctx.defaultSpaceId }),
    ).rejects.toMatchObject({ status: 404 });

    await ensureSession("chs_space_kind", ctx.orgId, ctx.user.id, { spaceId: ctx.defaultSpaceId });
    await expect(
      ensureSession("chs_space_kind", ctx.orgId, ctx.user.id, { spaceId: null, readable: [] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
