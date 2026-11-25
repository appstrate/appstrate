// SPDX-License-Identifier: Apache-2.0

/**
 * Chat sessions, served at `/api/orgs/:orgId/chat/*`: the one kind of conversation.
 *
 * A conversation belongs to the organization and its author. Its nullable origin space
 * (`chat_sessions.space_id`) is not an owner: the touched set (the origin space plus
 * `chat_session_spaces`) filters it (`?spaceId=`), and its author opens it only while they
 * reach every space of that set with `chat:read`. `restricted` limits it to the origin space.
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
import { seedApiKey, seedSpace, seedSpaceMember } from "../../../apps/api/test/helpers/seed.ts";
import { deleteOrganization } from "../../../apps/api/src/services/organizations.ts";
import { ensureSession, touchSessionSpace, writingOriginSpace } from "../src/persistence.ts";
import { mintMcpLoopbackToken } from "../src/loopback-auth.ts";
import { orgPermissions } from "../../../apps/api/src/lib/permissions.ts";
import { installPermissionAuditLogger } from "../../../apps/api/src/lib/permission-audit.ts";
import { readHandlerMarker } from "../../../apps/api/src/middleware/handler-marker.ts";
import { buildModuleInitContext } from "../../../apps/api/src/lib/modules/registry.ts";
import {
  PERMISSION_REQUIREMENT_MARKER,
  setPermissionDenialHandler,
} from "@appstrate/core/permissions";
import { createChatRouter } from "../src/routes.ts";
import { buildChatPlatformDeps } from "../src/platform-services.ts";

const app = getTestApp();

const JSON_HEADERS = { "Content-Type": "application/json" };

interface SessionDto {
  id: string;
  spaceId: string | null;
  restricted: boolean;
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
  body: { title?: string; spaceId?: string; restricted?: boolean } = {},
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

const orgCallAs = (ctx: TestContext, id: string) => orgCall(ctx, `/sessions/${id}`);

const touch = async (sessionId: string, spaceId: string) => {
  const [session] = await db
    .select({ orgId: chatSessions.orgId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  await db.insert(chatSessionSpaces).values({ sessionId, spaceId, orgId: session!.orgId });
};

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
    expect(created.spaceId).toBeNull();
    expect(created.restricted).toBe(false);
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

  describe("creating with an origin space", () => {
    it("records it as the origin space, touched by definition and recorded nowhere else", async () => {
      const created = await createSession(ctx, { spaceId: spaceB });
      expect(created.spaceId).toBe(spaceB);
      expect(created.restricted).toBe(false);
      expect(created.space_ids).toEqual([spaceB]);
      expect(await touchedBy(created.id)).toEqual([]);
      expect(await listSessionIds(ctx, `?spaceId=${spaceB}`)).toEqual([created.id]);
      expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([]);
    });

    it("has no origin space from the overview", async () => {
      const created = await createSession(ctx);
      expect(created.spaceId).toBeNull();
      expect(created.space_ids).toEqual([]);
      expect(await touchedBy(created.id)).toEqual([]);
      expect(await listSessionIds(ctx)).toEqual([created.id]);
    });

    it("limits the conversation to its origin space with restricted, which needs spaceId", async () => {
      const limited = await createSession(ctx, { spaceId: spaceB, restricted: true });
      expect(limited.restricted).toBe(true);
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, limited.id));
      expect(row).toMatchObject({ spaceId: spaceB, restricted: true });

      const refused = await orgCall(ctx, "/sessions", {
        method: "POST",
        body: JSON.stringify({ restricted: true }),
      });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain("restricted");
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

  describe("the stored origin space and limit", () => {
    it("leaves the origin space nullable and refuses a limit without one (check constraint)", async () => {
      await db
        .insert(chatSessions)
        .values({ id: "chs_no_origin", orgId: ctx.orgId, userId: ctx.user.id });
      await expect(
        (async () => {
          await db.insert(chatSessions).values({
            id: "chs_bad_limit",
            orgId: ctx.orgId,
            userId: ctx.user.id,
            restricted: true,
          });
        })(),
      ).rejects.toThrow();
      await db.insert(chatSessions).values({
        id: "chs_good_limit",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        spaceId: spaceB,
        restricted: true,
      });
    });

    it("records a touched space only within the conversation's organization (composite FKs)", async () => {
      const created = await createSession(ctx);
      const foreign = await createTestContext({ orgSlug: "othertenant" });
      // The space is another organization's: refused whatever `org_id` claims.
      for (const orgId of [ctx.orgId, foreign.orgId]) {
        await expect(
          (async () => {
            await db
              .insert(chatSessionSpaces)
              .values({ sessionId: created.id, spaceId: foreign.defaultSpaceId, orgId });
          })(),
        ).rejects.toThrow();
      }
      expect(await touchedBy(created.id)).toEqual([]);
      await touch(created.id, spaceB);
      expect(await touchedBy(created.id)).toEqual([spaceB]);
    });

    it("detaches the conversation from its deleted origin space, lifting its limit", async () => {
      const spaceC = (await seedSpace({ orgId: ctx.orgId, name: "Space C" })).id;
      const created = await createSession(ctx, { spaceId: spaceB, restricted: true });
      await touch(created.id, spaceC);
      const deleted = await app.request(`/api/spaces/${spaceB}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(ctx),
      });
      expect(deleted.status).toBe(204);
      const res = await orgCall(ctx, `/sessions/${created.id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        spaceId: null,
        restricted: false,
        space_ids: [spaceC],
      });
      expect(await listSessionIds(ctx, `?spaceId=${spaceC}`)).toEqual([created.id]);
    });

    it("leaves an organization deletable with a limited conversation", async () => {
      const created = await createSession(ctx, { spaceId: spaceB, restricted: true });
      await deleteOrganization(ctx.orgId);
      expect(await db.select().from(chatSessions).where(eq(chatSessions.id, created.id))).toEqual(
        [],
      );
    });
  });

  describe("PATCH …/sessions/:id", () => {
    const patch = (caller: TestContext, id: string, body: unknown) =>
      orgCall(caller, `/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    const restrictedOf = async (id: string) =>
      (await db.select().from(chatSessions).where(eq(chatSessions.id, id)))[0]!.restricted;

    it("limits a conversation to its origin space, and lifts the limit", async () => {
      const created = await createSession(ctx, { spaceId: spaceB });
      expect((await patch(ctx, created.id, { restricted: true })).status).toBe(204);
      expect(await restrictedOf(created.id)).toBe(true);
      expect((await patch(ctx, created.id, { restricted: false })).status).toBe(204);
      expect(await restrictedOf(created.id)).toBe(false);
      // Renaming and limiting go together.
      expect((await patch(ctx, created.id, { title: "T", restricted: true })).status).toBe(204);
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, created.id));
      expect(row).toMatchObject({ title: "T", restricted: true });
    });

    it("reorders the sidebar for a rename only, never for the limit", async () => {
      const created = await createSession(ctx, { spaceId: spaceB });
      const updatedAtOf = async () =>
        (await db.select().from(chatSessions).where(eq(chatSessions.id, created.id)))[0]!.updatedAt;
      const before = new Date("2026-01-01T00:00:00.000Z");
      await db
        .update(chatSessions)
        .set({ updatedAt: before })
        .where(eq(chatSessions.id, created.id));
      expect((await patch(ctx, created.id, { restricted: true })).status).toBe(204);
      expect((await patch(ctx, created.id, { restricted: false })).status).toBe(204);
      expect((await updatedAtOf()).getTime()).toBe(before.getTime());
      expect((await patch(ctx, created.id, { title: "Renamed" })).status).toBe(204);
      expect((await updatedAtOf()).getTime()).toBeGreaterThan(before.getTime());
    });

    it("refuses a limit without an origin space (400 naming the field), but lifts one always", async () => {
      const overview = await createSession(ctx);
      const refused = await patch(ctx, overview.id, { restricted: true });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain("restricted");
      expect(await restrictedOf(overview.id)).toBe(false);
      expect((await patch(ctx, overview.id, { restricted: false })).status).toBe(204);
    });

    it("refuses a limit to an origin space the caller cannot act in, and still lifts it", async () => {
      // Acting in one closed space (runner), only reading the origin space (viewer).
      const acting = (await seedSpace({ orgId: ctx.orgId, name: "Acting", visibility: "closed" }))
        .id;
      const readOnly = (
        await seedSpace({ orgId: ctx.orgId, name: "Read only", visibility: "closed" })
      ).id;
      const member = await memberContext(ctx, "member", "viewer");
      await seedSpaceMember({ spaceId: acting, userId: member.user.id, presetRole: "runner" });
      await seedSpaceMember({ spaceId: readOnly, userId: member.user.id, presetRole: "viewer" });
      await db.insert(chatSessions).values({
        id: "chs_read_only_origin",
        orgId: ctx.orgId,
        userId: member.user.id,
        spaceId: readOnly,
        restricted: true,
      });
      const refused = await patch(member, "chs_read_only_origin", { restricted: true });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(await refused.json())).toContain("restricted");
      expect((await patch(member, "chs_read_only_origin", { restricted: false })).status).toBe(204);
      expect(await restrictedOf("chs_read_only_origin")).toBe(false);
    });

    it("requires at least one field", async () => {
      const created = await createSession(ctx);
      expect((await patch(ctx, created.id, {})).status).toBe(400);
      // An unknown field is a 400, never dropped.
      expect((await patch(ctx, created.id, { title: "T", other: 1 })).status).toBe(400);
    });

    describe("giving a conversation without an origin its space, by limiting it there", () => {
      const rowOf = async (id: string) =>
        (await db.select().from(chatSessions).where(eq(chatSessions.id, id)))[0]!;
      const fieldOf = async (res: Response) => JSON.stringify(await res.json());

      it("sets the origin and the limit together, and lists it under that space alone", async () => {
        const overview = await createSession(ctx);
        expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([overview.id]);
        const res = await patch(ctx, overview.id, { spaceId: spaceB, restricted: true });
        expect(res.status).toBe(204);
        expect(await rowOf(overview.id)).toMatchObject({ spaceId: spaceB, restricted: true });
        expect(await listSessionIds(ctx, `?spaceId=${spaceB}`)).toEqual([overview.id]);
        expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([]);
        const dto = (await (await orgCallAs(ctx, overview.id)).json()) as SessionDto;
        expect(dto).toMatchObject({ spaceId: spaceB, restricted: true, space_ids: [spaceB] });
        // Lifting the limit keeps the origin.
        expect((await patch(ctx, overview.id, { restricted: false })).status).toBe(204);
        expect(await rowOf(overview.id)).toMatchObject({ spaceId: spaceB, restricted: false });
      });

      it("keeps the spaces touched before, the new origin listed once and first", async () => {
        const overview = await createSession(ctx);
        await touch(overview.id, ctx.defaultSpaceId);
        await touch(overview.id, spaceB);
        expect((await patch(ctx, overview.id, { spaceId: spaceB, restricted: true })).status).toBe(
          204,
        );
        expect(await touchedBy(overview.id)).toEqual([ctx.defaultSpaceId]);
        const dto = (await (await orgCallAs(ctx, overview.id)).json()) as SessionDto;
        expect(dto.space_ids).toEqual([spaceB, ctx.defaultSpaceId]);
        expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([overview.id]);
      });

      it("refuses spaceId once the origin is set, even the same one (400 naming spaceId)", async () => {
        const created = await createSession(ctx, { spaceId: ctx.defaultSpaceId });
        for (const spaceId of [spaceB, ctx.defaultSpaceId]) {
          const refused = await patch(ctx, created.id, { spaceId, restricted: true });
          expect(refused.status).toBe(400);
          expect(await fieldOf(refused)).toContain("spaceId");
        }
        expect(await rowOf(created.id)).toMatchObject({
          spaceId: ctx.defaultSpaceId,
          restricted: false,
        });
      });

      it("refuses spaceId without restricted: true (400 naming spaceId)", async () => {
        const overview = await createSession(ctx);
        for (const body of [
          { spaceId: spaceB },
          { spaceId: spaceB, restricted: false },
          { spaceId: spaceB, title: "T" },
        ]) {
          const refused = await patch(ctx, overview.id, body);
          expect(refused.status).toBe(400);
          expect(await fieldOf(refused)).toContain("spaceId");
        }
        expect(await rowOf(overview.id)).toMatchObject({ spaceId: null, restricted: false });
      });

      it("refuses a space outside the caller's acting set, the row unchanged (400 naming spaceId)", async () => {
        const acting = (await seedSpace({ orgId: ctx.orgId, name: "Acting", visibility: "closed" }))
          .id;
        const readOnly = (
          await seedSpace({ orgId: ctx.orgId, name: "Read only", visibility: "closed" })
        ).id;
        const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" }))
          .id;
        const foreign = await createTestContext({ orgSlug: "foreignspace" });
        const member = await memberContext(ctx, "member", "viewer");
        await seedSpaceMember({ spaceId: acting, userId: member.user.id, presetRole: "runner" });
        await seedSpaceMember({ spaceId: readOnly, userId: member.user.id, presetRole: "viewer" });
        await db
          .insert(chatSessions)
          .values({ id: "chs_no_origin", orgId: ctx.orgId, userId: member.user.id });
        // Read only, a closed space never joined, another organization's, an unknown id.
        for (const spaceId of [readOnly, closed, foreign.defaultSpaceId, "spc_nonexistent"]) {
          const refused = await patch(member, "chs_no_origin", { spaceId, restricted: true });
          expect(refused.status).toBe(400);
          expect(await fieldOf(refused)).toContain("spaceId");
          expect(await rowOf("chs_no_origin")).toMatchObject({ spaceId: null, restricted: false });
        }
        expect(await touchedBy("chs_no_origin")).toEqual([]);
        expect(
          (await patch(member, "chs_no_origin", { spaceId: acting, restricted: true })).status,
        ).toBe(204);
        expect(await rowOf("chs_no_origin")).toMatchObject({ spaceId: acting, restricted: true });
      });

      it("refuses it while a turn is running (409): the turn claims on the scope it read", async () => {
        const overview = await createSession(ctx);
        await db
          .update(chatSessions)
          .set({ activeStreamId: "stream_live" })
          .where(eq(chatSessions.id, overview.id));
        const refused = await patch(ctx, overview.id, { spaceId: spaceB, restricted: true });
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { code: string }).code).toBe("chat_turn_in_flight");
        expect(await rowOf(overview.id)).toMatchObject({ spaceId: null, restricted: false });
      });
    });

    it("refuses changing the limit while a turn is running (409), and still renames", async () => {
      const created = await createSession(ctx, { spaceId: spaceB });
      await db
        .update(chatSessions)
        .set({ activeStreamId: "stream_live" })
        .where(eq(chatSessions.id, created.id));
      const refused = await patch(ctx, created.id, { title: "T", restricted: true });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("chat_turn_in_flight");
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, created.id));
      expect(row).toMatchObject({ title: null, restricted: false });
      // Restating the stored limit changes nothing, so the turn does not stand in the way.
      expect((await patch(ctx, created.id, { title: "T", restricted: false })).status).toBe(204);
    });

    it("refuses lifting the limit while a turn is running (409): the turn keeps its narrow reach", async () => {
      const created = await createSession(ctx, { spaceId: spaceB, restricted: true });
      await db
        .update(chatSessions)
        .set({ activeStreamId: "stream_live" })
        .where(eq(chatSessions.id, created.id));
      const refused = await patch(ctx, created.id, { restricted: false });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("chat_turn_in_flight");
      expect(await restrictedOf(created.id)).toBe(true);
      // Restating the limit changes nothing, so the turn does not stand in the way.
      expect((await patch(ctx, created.id, { restricted: true })).status).toBe(204);
      expect(await restrictedOf(created.id)).toBe(true);
    });
  });

  it("lets an author without mcp:read manage a conversation they cannot start", async () => {
    // chat:read and chat:write, no mcp:read: no turn acts, but the conversation is theirs.
    // Its own org: Space B, open, would make any member of this one an operator.
    const author = await memberHolding(await createTestContext({ orgSlug: "notools" }), [
      "chat:read",
      "chat:write",
    ]);
    expect(
      (await orgCall(author, "/sessions", { method: "POST", body: JSON.stringify({}) })).status,
    ).toBe(403);
    await db
      .insert(chatSessions)
      .values({ id: "chs_no_tools", orgId: author.orgId, userId: author.user.id });
    const at = (suffix: string, init: RequestInit) =>
      orgCall(author, `/sessions/chs_no_tools${suffix}`, init);
    expect((await at("/read", { method: "PUT" })).status).toBe(204);
    expect((await at("", { method: "PATCH", body: JSON.stringify({ title: "T" }) })).status).toBe(
      204,
    );
    expect((await at("/stop", { method: "POST" })).status).toBe(204);
    expect((await at("", { method: "DELETE" })).status).toBe(204);
  });

  describe("GET …/sessions?spaceId=", () => {
    it("lists the conversations that touched the space, whatever else they touched, and those that touched none", async () => {
      const a = await createSession(ctx, { spaceId: ctx.defaultSpaceId });
      const b = await createSession(ctx, { spaceId: spaceB });
      const both = await createSession(ctx, { spaceId: spaceB });
      await touch(both.id, ctx.defaultSpaceId);
      const overview = await createSession(ctx);

      expect(new Set(await listSessionIds(ctx))).toEqual(
        new Set([a.id, b.id, both.id, overview.id]),
      );
      expect(new Set(await listSessionIds(ctx, `?spaceId=${spaceB}`))).toEqual(
        new Set([b.id, both.id, overview.id]),
      );
      expect(new Set(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`))).toEqual(
        new Set([a.id, both.id, overview.id]),
      );
      const dto = (await (await orgCall(ctx, `/sessions/${both.id}`)).json()) as SessionDto;
      expect([...dto.space_ids].sort()).toEqual([ctx.defaultSpaceId, spaceB].sort());
    });

    it("also lists a conversation that touched no space: it holds no space's data", async () => {
      const untouched = await createSession(ctx);
      const inB = await createSession(ctx, { spaceId: spaceB });
      expect(new Set(await listSessionIds(ctx, `?spaceId=${spaceB}`))).toEqual(
        new Set([inB.id, untouched.id]),
      );
      expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([untouched.id]);
      // Its first act decides: once it touched B, it leaves the other spaces' lists.
      await touch(untouched.id, spaceB);
      expect(await listSessionIds(ctx, `?spaceId=${ctx.defaultSpaceId}`)).toEqual([]);
      // The cursor is validated within the same filtered set.
      const fresh = await createSession(ctx);
      const res = await orgCall(
        ctx,
        `/sessions?spaceId=${ctx.defaultSpaceId}&startingAfter=${fresh.id}`,
      );
      expect(res.status).toBe(200);
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

  it("hides a conversation whose origin space the reader cannot read", async () => {
    const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" })).id;
    const member = await memberContext(ctx, "member", "operator");
    await db.insert(chatSessions).values({
      id: "chs_closed_origin",
      orgId: ctx.orgId,
      userId: member.user.id,
      spaceId: closed,
    });
    expect((await orgCall(member, "/sessions/chs_closed_origin")).status).toBe(404);
    expect(await listSessionIds(member)).not.toContain("chs_closed_origin");
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

    // A touched space the member does not reach hides the session (every route: the table below).
    await touch(session.id, closed);
    expect(await listSessionIds(member)).not.toContain(session.id);

    // The space going away drops it from the record (cascade): listed again.
    await db.delete(spaces).where(eq(spaces.id, closed));
    expect(await listSessionIds(member)).toContain(session.id);
  });

  describe("a conversation that touched a space the author cannot read", () => {
    // Resume answers 204 (nothing to resume) rather than 404 — the same answer as a
    // conversation that has no row yet; what matters is that it never replays a stream.
    const routes: [string, string, string, number][] = [
      ["get", "GET", "", 404],
      ["rename", "PATCH", "", 404],
      ["delete", "DELETE", "", 404],
      ["mark read", "PUT", "/read", 404],
      ["stop", "POST", "/stop", 404],
      ["resume stream", "GET", "/stream", 204],
    ];
    it.each(routes)("%s of a hidden conversation", async (_name, method, suffix, status) => {
      const closed = (await seedSpace({ orgId: ctx.orgId, name: "Closed", visibility: "closed" }))
        .id;
      const member = await memberContext(ctx, "member", "operator");
      const session = await createSession(member, { title: "Hidden" });
      await touch(session.id, closed);
      const res = await orgCall(member, `/sessions/${session.id}${suffix}`, {
        method,
        ...(method === "PATCH" ? { body: JSON.stringify({ title: "x" }) } : {}),
      });
      expect(res.status).toBe(status);
      const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, session.id));
      expect(row?.title).toBe("Hidden");
    });
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

  it("reports a denial through the platform's audit hook, naming the grant it lacked", async () => {
    const denied: string[] = [];
    setPermissionDenialHandler(({ required }) => denied.push(required));
    try {
      // Its own org: Space B, open, would make any member of this one an operator.
      const outsider = await memberHolding(await createTestContext({ orgSlug: "denied" }), [
        "agents:read",
      ]);
      expect((await orgCall(outsider, "/sessions")).status).toBe(403);
      expect(denied).toEqual(["chat:read"]);
    } finally {
      installPermissionAuditLogger();
    }
  });

  it("stamps each route with what its guards enforce, a turn with the three grants it acts on", () => {
    const router = createChatRouter(buildChatPlatformDeps(buildModuleInitContext()));
    const requirements = (method: string, path: string) =>
      router.routes
        .filter((route) => route.method === method && route.path === path)
        .map((route) => readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER))
        .filter((value) => value !== undefined);
    expect(requirements("POST", "/api/orgs/:orgId/chat")).toEqual([
      "chat:read",
      "mcp:read",
      "chat:write",
    ]);
    expect(requirements("POST", "/api/orgs/:orgId/chat/sessions")).toEqual([
      "chat:read",
      "mcp:read",
      "chat:write",
    ]);
    expect(requirements("GET", "/api/orgs/:orgId/chat/sessions")).toEqual(["chat:read"]);
    expect(requirements("PATCH", "/api/orgs/:orgId/chat/sessions/:id")).toEqual(["chat:write"]);
    for (const route of router.routes.filter((r) => r.path.startsWith("/api/orgs/:orgId/chat"))) {
      if (readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER) === undefined) continue;
      expect(readHandlerMarker(route.handler, Symbol.for("appstrate.permissionGuard"))).toBe(true);
    }
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
    expect(((await res.json()) as { detail: string }).detail).toContain("confined to spaces");
  });

  it("refuses a turn's own bearer (a space allowlist): a turn opens no conversation nor turn", async () => {
    const headers = {
      Authorization: `Bearer ${mintMcpLoopbackToken({
        userId: ctx.user.id,
        email: ctx.user.email,
        name: ctx.user.name,
        orgId: ctx.orgId,
        orgRole: "owner",
        permissions: [...orgPermissions("owner"), "chat:read", "chat:write", "mcp:read"],
        spaceIds: [ctx.defaultSpaceId],
      })}`,
      "Content-Type": "application/json",
    };
    const list = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, { headers });
    const created = await app.request(`/api/orgs/${ctx.orgId}/chat/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ spaceId: ctx.defaultSpaceId }),
    });
    const turn = await app.request(`/api/orgs/${ctx.orgId}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: crypto.randomUUID(), messages: [] }),
    });
    for (const res of [list, created, turn]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { detail: string }).detail).toContain("confined to spaces");
    }
    expect(await db.select({ id: chatSessions.id }).from(chatSessions)).toEqual([]);
  });
});

describe("an origin space deleted between its check and the write", () => {
  it("refuses the write on its foreign key, answered as the 400 naming spaceId", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "originrace" });
    // The space the check accepted, gone by the time the row names it.
    const write = () =>
      db.insert(chatSessions).values({
        id: "chs_origin_race",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        spaceId: "spc_deleted_since",
      });
    const raw = await write().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(raw).toBeDefined();
    await expect(writingOriginSpace(write)).rejects.toMatchObject({
      status: 400,
      param: "spaceId",
    });
    expect(await db.select().from(chatSessions)).toEqual([]);
  });

  it("lets every other failure through", async () => {
    const other = new Error("boom");
    await expect(writingOriginSpace(() => Promise.reject(other))).rejects.toBe(other);
    const missingUser = new Error("insert failed", {
      cause: {
        code: "23503",
        constraint_name: "chat_sessions_user_id_user_id_fk",
      },
    });
    await expect(writingOriginSpace(() => Promise.reject(missingUser))).rejects.toBe(missingUser);
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

  it("refuses a session id that belongs to another author, and changes nothing for them", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensureowner" });
    const stranger = await memberContext(ctx, "member", "operator");
    await ensureSession("chs_owned", ctx.orgId, ctx.user.id, []);
    await expect(
      ensureSession("chs_owned", ctx.orgId, stranger.user.id, [], undefined, () => ({
        spaceId: ctx.defaultSpaceId,
        restricted: true,
      })),
    ).rejects.toMatchObject({ status: 404 });
    const [row] = await db.select().from(chatSessions).where(eq(chatSessions.id, "chs_owned"));
    expect(row).toMatchObject({ spaceId: null, restricted: false });
    expect(await touchedBy("chs_owned")).toEqual([]);
  });

  it("takes the origin space and limit only when it creates the row", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensureorigin" });
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    const readable = [ctx.defaultSpaceId, other];

    const created = await ensureSession(
      "chs_origin",
      ctx.orgId,
      ctx.user.id,
      readable,
      undefined,
      () => ({ spaceId: other, restricted: true }),
    );
    expect(created).toMatchObject({ spaceId: other, restricted: true });
    // An existing conversation keeps its own, whatever a later turn carries.
    const again = await ensureSession(
      "chs_origin",
      ctx.orgId,
      ctx.user.id,
      readable,
      undefined,
      () => ({ spaceId: ctx.defaultSpaceId, restricted: false }),
    );
    expect(again).toMatchObject({ spaceId: other, restricted: true });
    // The overview has none.
    expect(await ensureSession("chs_overview", ctx.orgId, ctx.user.id, readable)).toMatchObject({
      spaceId: null,
      restricted: false,
    });
    // Nothing is recorded as touched by an origin space.
    expect(await touchedBy("chs_origin")).toEqual([]);
  });

  it("writes the skill selection only when it creates the row", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "ensureskills" });
    const created = await ensureSession("chs_skills", ctx.orgId, ctx.user.id, [], {
      pinnedSkills: ["@acme/a"],
      skillDiscovery: false,
    });
    expect(created).toMatchObject({
      selection: { pinnedSkills: ["@acme/a"], skillDiscovery: false },
    });
    // An existing conversation keeps its own: the skills PATCH alone changes it.
    const again = await ensureSession("chs_skills", ctx.orgId, ctx.user.id, [], {
      pinnedSkills: ["@acme/b"],
      skillDiscovery: true,
    });
    expect(again).toMatchObject({
      selection: { pinnedSkills: ["@acme/a"], skillDiscovery: false },
    });
  });
});

describe("touchSessionSpace", () => {
  it("records a space once, and never the origin space", async () => {
    await truncateAll();
    const ctx = await createTestContext({ orgSlug: "touchorigin" });
    const other = (await seedSpace({ orgId: ctx.orgId, name: "Other" })).id;
    await ensureSession(
      "chs_touch",
      ctx.orgId,
      ctx.user.id,
      [ctx.defaultSpaceId, other],
      undefined,
      () => ({ spaceId: ctx.defaultSpaceId, restricted: false }),
    );
    const session = {
      id: "chs_touch",
      orgId: ctx.orgId,
      userId: ctx.user.id,
      originSpaceId: ctx.defaultSpaceId,
    };
    await touchSessionSpace(session, ctx.defaultSpaceId);
    expect(await touchedBy("chs_touch")).toEqual([]);
    await touchSessionSpace(session, other);
    await touchSessionSpace(session, other);
    expect(await touchedBy("chs_touch")).toEqual([other]);
    const dto = (await (await orgCallAs(ctx, "chs_touch")).json()) as SessionDto;
    expect(dto.space_ids).toEqual([ctx.defaultSpaceId, other]);
  });
});
