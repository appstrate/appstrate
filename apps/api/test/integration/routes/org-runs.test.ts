// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/runs` — the runs of every space the caller reads runs
 * in, each space contributing what the caller's role THERE grants.
 *
 * | credential                                 | space                                         | rows                                  |
 * | ------------------------------------------ | --------------------------------------------- | ------------------------------------- |
 * | member session                             | custom role holding `runs:read-all` (Un)      | every run of Un                       |
 * | member session                             | custom role holding `runs:read` only (Deux)   | the member's own runs of Deux         |
 * | member session                             | open space, default role `operator` (Default) | the member's own runs of Default      |
 * | member session                             | `closed` space, not joined (Fermé)            | none; `spaceId` = it → 400            |
 * | member session                             | `private` space, not a member (Privé)         | none; `spaceId` = it → the same 400   |
 * | owner session                              | every team space (preset `admin`)             | every run                             |
 * | guest session                              | explicit `runs:read` row (Un)                 | the guest's own runs of Un            |
 * | guest session                              | no row anywhere                               | empty page, 200                       |
 * | owner session + `X-View-As: org_role=member` | the persona's reach (Default, `operator`)   | the owner's own runs of Default       |
 * | API key pinned to Un (creator: owner)      | Un only                                       | every run of Un; `spaceId` = Deux → 400 |
 * | API key + `Appstrate-User` (end-user)      | —                                             | 403                                   |
 * | chat loopback bearer (user, ceiling)       | the session's reach, capped by the ceiling    | ceiling `runs:read` → own runs only   |
 * | any                                        | another organization                          | never; its path → 403                 |
 * | member session                             | own live personal space                       | the member's runs there               |
 * | owner / admin session                      | a member's live personal space                | never                                 |
 * | owner / admin session                      | an orphaned personal space (listed, no role)  | never                                 |
 * | API key of the personal space's owner      | pinned to that personal space                 | none: a delegate reaches no personal space |
 * | owner session + `X-View-As: org_role=member` | the previewer's own personal space          | never: a persona owns none            |
 *
 * A third-party OAuth client (the other `delegate`) is not exercised here: no
 * core test helper mints one; it shares the API key's `principalKind`, which is
 * what `callerPersonalOwnerId` reads.
 *
 * The MCP door (`invoke_operation` with a minted instance token) is covered in
 * `modules/mcp/test/integration/org-reads.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  createTestUser,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedEndUser,
  seedPackage,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";
import { removeMember } from "../../../src/services/organizations.ts";

const app = getTestApp();

interface ListedRun {
  id: string;
  spaceId: string;
  input: Record<string, unknown> | null;
}
interface RunPage {
  object: string;
  data: ListedRun[];
  total: number;
  hasMore: boolean;
}

describe("GET /api/orgs/{orgId}/runs", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let deux: string;
  let ferme: string;
  let prive: string;
  /** Run ids by space and launcher. */
  let r: Record<string, string>;
  let foreignRun: string;
  let foreignOrgId: string;

  async function seedSpaceRun(spaceId: string, userId: string, orgId = owner.orgId) {
    const pkg = await seedPackage({
      id: `@orgruns/agent-${crypto.randomUUID().slice(0, 8)}`,
      orgId,
      homeSpaceId: spaceId,
      createdBy: userId,
    });
    const run = await seedRun({
      packageId: pkg.id,
      orgId,
      spaceId,
      userId,
      status: "success",
      input: { imposed: "value" },
      startedAt: new Date(),
    });
    return run.id;
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgruns" });
    member = await memberContext(owner, "member");
    un = (await seedSpace({ orgId: owner.orgId, name: "Un", visibility: "closed" })).id;
    deux = (await seedSpace({ orgId: owner.orgId, name: "Deux", visibility: "closed" })).id;
    ferme = (await seedSpace({ orgId: owner.orgId, name: "Fermé", visibility: "closed" })).id;
    prive = (await seedSpace({ orgId: owner.orgId, name: "Privé", visibility: "private" })).id;
    const readAll = await seedSpaceRole({
      orgId: owner.orgId,
      permissions: ["runs:read-all", "agents:read"],
    });
    const readOwn = await seedSpaceRole({ orgId: owner.orgId, permissions: ["runs:read"] });
    await seedSpaceMember({
      spaceId: un,
      userId: member.user.id,
      presetRole: null,
      customRoleId: readAll.id,
    });
    await seedSpaceMember({
      spaceId: deux,
      userId: member.user.id,
      presetRole: null,
      customRoleId: readOwn.id,
    });
    r = {
      unOwner: await seedSpaceRun(un, owner.user.id),
      unMember: await seedSpaceRun(un, member.user.id),
      deuxOwner: await seedSpaceRun(deux, owner.user.id),
      deuxMember: await seedSpaceRun(deux, member.user.id),
      defaultOwner: await seedSpaceRun(owner.defaultSpaceId, owner.user.id),
      defaultMember: await seedSpaceRun(owner.defaultSpaceId, member.user.id),
      ferme: await seedSpaceRun(ferme, owner.user.id),
      prive: await seedSpaceRun(prive, owner.user.id),
    };
    // Another organization, where the member also belongs: its runs never leak in.
    const foreign = await createTestContext({ orgSlug: "orgruns-foreign" });
    foreignOrgId = foreign.orgId;
    await addOrgMember(foreign.orgId, member.user.id, "member");
    foreignRun = await seedSpaceRun(foreign.defaultSpaceId, member.user.id, foreign.orgId);
  });

  const path = (query = "", orgId = owner.orgId) => `/api/orgs/${orgId}/runs${query}`;
  const session = (ctx: TestContext, extra: Record<string, string> = {}) => ({
    Cookie: ctx.cookie,
    ...extra,
  });

  async function list(headers: Record<string, string>, query = ""): Promise<RunPage> {
    const res = await app.request(path(query), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as RunPage;
  }
  const ids = (page: RunPage) => page.data.map((run) => run.id).sort();
  const sorted = (...values: string[]) => values.sort();

  it("serves each space what the member's role there grants, and nothing of the others", async () => {
    const page = await list(session(member));
    expect(ids(page)).toEqual(sorted(r.unOwner!, r.unMember!, r.deuxMember!, r.defaultMember!));
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(false);
    expect(ids(page)).not.toContain(foreignRun);
    // Rows carry their space; the client names it from `GET /api/spaces`.
    const byId = new Map(page.data.map((run) => [run.id, run]));
    expect(byId.get(r.unOwner!)!.spaceId).toBe(un);
    expect(byId.get(r.deuxMember!)!.spaceId).toBe(deux);
  });

  it("decides agent input per row, by the row's space", async () => {
    const byId = new Map((await list(session(member))).data.map((run) => [run.id, run]));
    // `agents:read` in Un, not in Deux: one page, two answers.
    expect(byId.get(r.unOwner!)!.input).toEqual({ imposed: "value" });
    expect(byId.get(r.deuxMember!)!.input).toBeNull();
  });

  it("pages across spaces with one total and a Link header", async () => {
    const first = await app.request(path("?limit=3"), { headers: session(member) });
    expect(first.status).toBe(200);
    expect(first.headers.get("Link")).toContain('rel="next"');
    const page1 = (await first.json()) as RunPage;
    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(4);
    expect(page1.hasMore).toBe(true);
    const page2 = await list(session(member), "?limit=3&offset=3");
    expect(page2.data).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect([...ids(page1), ...ids(page2)].sort()).toEqual(
      sorted(r.unOwner!, r.unMember!, r.deuxMember!, r.defaultMember!),
    );
  });

  it("narrows to the caller's own runs with user=me, even where they read all", async () => {
    expect(ids(await list(session(member), "?user=me"))).toEqual(
      sorted(r.unMember!, r.deuxMember!, r.defaultMember!),
    );
  });

  it("narrows to the spaces spaceId names, comma-separated", async () => {
    expect(ids(await list(session(member), `?spaceId=${deux}`))).toEqual([r.deuxMember!]);
    expect(ids(await list(session(member), `?spaceId=${un},${deux}`))).toEqual(
      sorted(r.unOwner!, r.unMember!, r.deuxMember!),
    );
    // Empty reads as absent.
    expect((await list(session(member), "?spaceId=")).total).toBe(4);
  });

  it("answers a space the caller does not reach exactly as one that does not exist", async () => {
    const problem = async (spaceId: string) => {
      const res = await app.request(path(`?spaceId=${spaceId}`), { headers: session(member) });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      return {
        code: body.code,
        param: body.param,
        detail: String(body.detail).replace(spaceId, "<id>"),
      };
    };
    const unknown = await problem("spc_00000000000000000000000000");
    expect(unknown.param).toBe("spaceId");
    expect(await problem(ferme)).toEqual(unknown);
    expect(await problem(prive)).toEqual(unknown);
  });

  it("composes the filters of GET /api/runs and refuses an unknown value", async () => {
    expect((await list(session(member), "?status=failed")).total).toBe(0);
    const bad = await app.request(path("?kind=inlinee"), { headers: session(member) });
    expect(bad.status).toBe(400);
  });

  it("serves the owner every run of every team space, private included", async () => {
    const page = await list(session(owner));
    expect(ids(page)).toEqual(sorted(...Object.values(r)));
  });

  it("serves a guest its own runs where it holds a row, and an empty page otherwise", async () => {
    const guestUser = await createTestUser();
    await addOrgMember(owner.orgId, guestUser.id, "guest");
    const guest = { ...owner, user: guestUser, cookie: guestUser.cookie };
    expect(await list(session(guest))).toMatchObject({ data: [], total: 0, hasMore: false });

    await seedSpaceMember({ spaceId: un, userId: guestUser.id, presetRole: "operator" });
    const guestRun = await seedSpaceRun(un, guestUser.id);
    expect(ids(await list(session(guest)))).toEqual([guestRun]);
  });

  it("answers the persona of a role preview, not the previewer", async () => {
    // As a member: Default is open (implicit `operator`, own runs), every other space is closed or private.
    const page = await list(session(owner, { "X-View-As": "org_role=member" }));
    expect(ids(page)).toEqual([r.defaultOwner!]);
  });

  it("bounds a space-pinned API key to its space", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: un,
      createdBy: owner.user.id,
      scopes: ["runs:read-all"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    expect(ids(await list(headers))).toEqual(sorted(r.unOwner!, r.unMember!));
    const outside = await app.request(path(`?spaceId=${deux}`), { headers });
    expect(outside.status).toBe(400);
    const otherOrg = await app.request(path("", foreignOrgId), { headers });
    expect(otherOrg.status).toBe(403);
  });

  it("refuses an end-user", async () => {
    const endUser = await seedEndUser({ orgId: owner.orgId, spaceId: un });
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: un,
      createdBy: owner.user.id,
      scopes: ["runs:read"],
    });
    const res = await app.request(path(), {
      headers: { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id },
    });
    expect(res.status).toBe(403);
  });

  it("caps the chat's loopback bearer with the permissions it carries", async () => {
    const loopback = (permissions: string[]) => ({
      Authorization: `Bearer ${mintMcpLoopbackToken({
        userId: member.user.id,
        email: member.user.email,
        name: member.user.name,
        orgId: owner.orgId,
        orgRole: "member",
        permissions,
      })}`,
      "X-Org-Id": owner.orgId,
    });
    const full = await list(loopback(["runs:read", "runs:read-all", "agents:read"]));
    expect(ids(full)).toEqual(sorted(r.unOwner!, r.unMember!, r.deuxMember!, r.defaultMember!));
    // Without `runs:read-all` in its ceiling, Un is own-only; without `agents:read`, no input.
    const capped = await list(loopback(["runs:read"]));
    expect(ids(capped)).toEqual(sorted(r.unMember!, r.deuxMember!, r.defaultMember!));
    expect(capped.data.every((run) => run.input === null)).toBe(true);
  });

  it("refuses an organization the caller is not a member of", async () => {
    const res = await app.request(path("", foreignOrgId), { headers: session(owner) });
    expect(res.status).toBe(403);
  });

  describe("personal spaces (RBAC spec §3.6)", () => {
    let admin: TestContext;

    /** The caller's own personal space id, from the listing that provisions it. */
    async function personalSpaceOf(ctx: TestContext): Promise<string> {
      const listed = await listedSpaces(ctx);
      const own = listed.filter((space) => space.personal);
      expect(own).toHaveLength(1);
      return own[0]!.id;
    }
    async function listedSpaces(ctx: TestContext) {
      const res = await app.request("/api/spaces", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": owner.orgId },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Array<{ id: string; personal: boolean }> }).data;
    }

    beforeEach(async () => {
      admin = await memberContext(owner, "admin");
    });

    it("reaches the member's own live personal space, and nobody else does", async () => {
      const personal = await personalSpaceOf(member);
      const run = await seedSpaceRun(personal, member.user.id);
      expect(ids(await list(session(member)))).toContain(run);
      expect(ids(await list(session(owner)))).not.toContain(run);
      expect(ids(await list(session(admin)))).not.toContain(run);
    });

    it("does not reach an orphaned personal space, listed to admins with no role", async () => {
      const personal = await personalSpaceOf(member);
      const run = await seedSpaceRun(personal, member.user.id);
      await removeMember(owner.orgId, member.user.id, {
        userId: owner.user.id,
        firstPartySession: true,
      });
      for (const ctx of [owner, admin]) {
        // Listed to them — and still not reached.
        expect((await listedSpaces(ctx)).map((space) => space.id)).toContain(personal);
        expect(ids(await list(session(ctx)))).not.toContain(run);
      }
    });

    it("does not reach a personal space through its owner's API key", async () => {
      const personal = await personalSpaceOf(member);
      const run = await seedSpaceRun(personal, member.user.id);
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: personal,
        createdBy: member.user.id,
        scopes: ["runs:read-all"],
      });
      const page = await list({ Authorization: `Bearer ${key.rawKey}` });
      expect(ids(page)).not.toContain(run);
      expect(page.total).toBe(0);
    });

    it("reaches no personal space under a role preview, not even the previewer's", async () => {
      const personal = await personalSpaceOf(owner);
      const run = await seedSpaceRun(personal, owner.user.id);
      expect(ids(await list(session(owner)))).toContain(run);
      const previewed = await list(session(owner, { "X-View-As": "org_role=member" }));
      expect(ids(previewed)).not.toContain(run);
    });
  });

  it("leaves GET /api/runs requiring X-Space-Id", async () => {
    const res = await app.request("/api/runs", {
      headers: { Cookie: member.cookie, "X-Org-Id": owner.orgId },
    });
    expect(res.status).toBe(400);
  });
});
