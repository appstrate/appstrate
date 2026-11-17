// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/runs` — the runs of every space the caller reads runs
 * in, each space contributing what the caller's role THERE grants — and
 * `GET /api/orgs/{orgId}/runs/{id}`, one of them under the same rule.
 *
 * | credential                                 | space                                         | rows                                  |
 * | ------------------------------------------ | --------------------------------------------- | ------------------------------------- |
 * | member session                             | custom role holding `runs:read-all` (Un)      | every run of Un                       |
 * | member session                             | custom role holding `runs:read` only (Deux)   | the member's own runs of Deux         |
 * | member session                             | open space, default role `operator` (Default) | the member's own runs of Default      |
 * | member session                             | custom role without run read (Trois)          | none                                  |
 * | member session                             | `closed` space, not joined (Fermé)            | none                                  |
 * | member session                             | `private` space, not a member (Privé)         | none                                  |
 * | guest session                              | explicit `operator` row (Un)                  | the guest's own runs of Un            |
 * | chat loopback bearer (user, ceiling)       | the session's reach, capped by the ceiling    | ceiling `runs:read` → own runs only   |
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
 * The reach every list shares (owner, guest, role preview, pinned and unscoped
 * API keys, end-user, unknown parameter, another organization) is in
 * `cross-space-reads.test.ts`; the MCP door in
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
  seedSpaceGrant,
} from "../../helpers/seed.ts";
import { memberLoopbackHeaders } from "../../helpers/loopback.ts";
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
  let trois: string;
  let ferme: string;
  let prive: string;
  /** Run ids by space and launcher. */
  let r: Record<string, string>;
  let foreignRun: string;

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
    trois = (await seedSpace({ orgId: owner.orgId, name: "Trois", visibility: "closed" })).id;
    ferme = (await seedSpace({ orgId: owner.orgId, name: "Fermé", visibility: "closed" })).id;
    prive = (await seedSpace({ orgId: owner.orgId, name: "Privé", visibility: "private" })).id;
    const grant = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await grant(un, ["runs:read-all", "agents:read"]);
    await grant(deux, ["runs:read"]);
    await grant(trois, ["agents:read"]);
    r = {
      unOwner: await seedSpaceRun(un, owner.user.id),
      unMember: await seedSpaceRun(un, member.user.id),
      deuxOwner: await seedSpaceRun(deux, owner.user.id),
      deuxMember: await seedSpaceRun(deux, member.user.id),
      troisMember: await seedSpaceRun(trois, member.user.id),
      defaultOwner: await seedSpaceRun(owner.defaultSpaceId, owner.user.id),
      defaultMember: await seedSpaceRun(owner.defaultSpaceId, member.user.id),
      ferme: await seedSpaceRun(ferme, owner.user.id),
      prive: await seedSpaceRun(prive, owner.user.id),
    };
    // Another organization, where the member also belongs: its runs never leak in.
    const foreign = await createTestContext({ orgSlug: "orgruns-foreign" });
    await addOrgMember(foreign.orgId, member.user.id, "member");
    foreignRun = await seedSpaceRun(foreign.defaultSpaceId, member.user.id, foreign.orgId);
  });

  const path = (query = "") => `/api/orgs/${owner.orgId}/runs${query}`;
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

  it("pages across spaces on a cursor, with one total and a Link header", async () => {
    const first = await app.request(path("?limit=3"), { headers: session(member) });
    expect(first.status).toBe(200);
    expect(first.headers.get("Link")).toContain('rel="next"');
    const page1 = (await first.json()) as RunPage;
    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(4);
    expect(page1.hasMore).toBe(true);
    const page2 = await list(session(member), `?limit=3&startingAfter=${page1.data.at(-1)!.id}`);
    expect(page2.data).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect([...ids(page1), ...ids(page2)].sort()).toEqual(
      sorted(r.unOwner!, r.unMember!, r.deuxMember!, r.defaultMember!),
    );
  });

  it("breaks a tie on start time by id, so cursor pages never overlap", async () => {
    const startedAt = new Date("2026-01-02T03:04:05.000Z");
    const pkg = await seedPackage({
      id: `@orgruns/tied-${crypto.randomUUID().slice(0, 8)}`,
      orgId: owner.orgId,
      homeSpaceId: un,
      createdBy: owner.user.id,
    });
    const tied: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await seedRun({
        packageId: pkg.id,
        orgId: owner.orgId,
        spaceId: un,
        userId: owner.user.id,
        status: "success",
        startedAt,
      });
      tied.push(run.id);
    }
    const query = `?end_date=${encodeURIComponent(startedAt.toISOString())}&limit=1`;
    const paged: string[] = [];
    let cursor = "";
    for (let i = 0; i < 3; i++) {
      const page = await list(session(member), `${query}${cursor}`);
      expect(page.total).toBe(3);
      paged.push(...ids(page));
      cursor = `&startingAfter=${page.data.at(-1)!.id}`;
    }
    expect(new Set(paged).size).toBe(3);
    expect(paged.sort()).toEqual(tied.sort());
  });

  it("takes no cursor from a run the caller cannot read: the page starts at the head", async () => {
    const head = await list(session(member), "?limit=2");
    // Deux's owner run: in a space the member reads, but not theirs to read there.
    for (const hidden of [r.deuxOwner!, r.ferme!, foreignRun]) {
      const page = await list(session(member), `?limit=2&startingAfter=${hidden}`);
      expect(ids(page)).toEqual(ids(head));
    }
  });

  it("narrows to the caller's own runs with user=me, even where they read all", async () => {
    expect(ids(await list(session(member), "?user=me"))).toEqual(
      sorted(r.unMember!, r.deuxMember!, r.defaultMember!),
    );
  });

  it("composes the filters of GET /api/runs and refuses an unknown value", async () => {
    expect((await list(session(member), "?status=failed")).total).toBe(0);
    const bad = await app.request(path("?kind=inlinee"), { headers: session(member) });
    expect(bad.status).toBe(400);
  });

  it("narrows to one agent's runs across spaces with packageId, within the caller's reach", async () => {
    const pkg = await seedPackage({
      id: "@orgruns/filtered",
      orgId: owner.orgId,
      homeSpaceId: un,
      createdBy: owner.user.id,
    });
    const seed = (spaceId: string, userId: string) =>
      seedRun({ packageId: pkg.id, orgId: owner.orgId, spaceId, userId, status: "success" });
    const inUn = await seed(un, owner.user.id);
    const inDeux = await seed(deux, member.user.id);
    // Deux reads the member's own runs only; Fermé is not reached.
    await seed(deux, owner.user.id);
    await seed(ferme, owner.user.id);
    const page = await list(session(member), `?packageId=${pkg.id}`);
    expect(ids(page)).toEqual(sorted(inUn.id, inDeux.id));
    expect(page.total).toBe(2);
    // An agent the caller reaches in no space yields an empty page, not a refusal.
    expect((await list(session(member), "?packageId=@orgruns/nowhere")).total).toBe(0);
    // A value that is not a package id is refused, never read as no filter.
    const bad = await app.request(path("?packageId=not-a-package"), { headers: session(member) });
    expect(bad.status).toBe(400);
  });

  it("serves a guest its own runs where it holds a row", async () => {
    const guestUser = await createTestUser();
    await addOrgMember(owner.orgId, guestUser.id, "guest");
    const guest = { ...owner, user: guestUser, cookie: guestUser.cookie };
    await seedSpaceMember({ spaceId: un, userId: guestUser.id, presetRole: "operator" });
    const guestRun = await seedSpaceRun(un, guestUser.id);
    expect(ids(await list(session(guest)))).toEqual([guestRun]);
  });

  it("caps the chat's loopback bearer with the permissions it carries", async () => {
    const loopback = (permissions: string[]) =>
      memberLoopbackHeaders(member, owner.orgId, permissions);
    const full = await list(loopback(["runs:read", "runs:read-all", "agents:read"]));
    expect(ids(full)).toEqual(sorted(r.unOwner!, r.unMember!, r.deuxMember!, r.defaultMember!));
    // Without `runs:read-all` in its ceiling, Un is own-only; without `agents:read`, no input.
    const capped = await list(loopback(["runs:read"]));
    expect(ids(capped)).toEqual(sorted(r.unMember!, r.deuxMember!, r.defaultMember!));
    expect(capped.data.every((run) => run.input === null)).toBe(true);
  });

  describe("GET /api/orgs/{orgId}/runs/{id}", () => {
    const onePath = (id: string, query = "") => `/api/orgs/${owner.orgId}/runs/${id}${query}`;
    const read = (id: string, headers: Record<string, string>, query = "") =>
      app.request(onePath(id, query), { headers });

    it("finds a run in whichever space holds it, with the space route's body", async () => {
      const res = await read(r.unOwner!, session(member));
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as ListedRun & { status: string };
      expect(body).toMatchObject({ id: r.unOwner, spaceId: un, input: { imposed: "value" } });
      const twin = await app.request(`/api/runs/${r.unOwner}`, {
        headers: session(member, { "X-Org-Id": owner.orgId, "X-Space-Id": un }),
      });
      expect(await twin.json()).toEqual(body);
    });

    it("judges each run under the grant of its own space", async () => {
      // Deux grants `runs:read` only: the member's own run, not the owner's, and no input.
      const own = await read(r.deuxMember!, session(member));
      expect(own.status).toBe(200);
      expect(((await own.json()) as ListedRun).input).toBeNull();
      expect((await read(r.deuxOwner!, session(member))).status).toBe(404);
      // Trois grants no run read, Fermé and Privé are not reached, the foreign org is another's.
      for (const id of [r.troisMember!, r.ferme!, r.prive!, foreignRun]) {
        expect((await read(id, session(member))).status, id).toBe(404);
      }
    });

    it("bounds a space-pinned API key to its space", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: un,
        createdBy: owner.user.id,
        scopes: ["runs:read-all"],
      });
      const headers = { Authorization: `Bearer ${key.rawKey}` };
      expect((await read(r.unMember!, headers)).status).toBe(200);
      expect((await read(r.defaultOwner!, headers)).status).toBe(404);
    });

    it("answers a role preview with the persona's reach", async () => {
      const headers = session(owner, { "X-View-As": "org_role=member" });
      expect((await read(r.defaultOwner!, headers)).status).toBe(200);
      expect((await read(r.unOwner!, headers)).status).toBe(404);
    });

    it("refuses an end-user, and an unknown query parameter", async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: un,
        createdBy: owner.user.id,
        scopes: ["runs:read-all"],
      });
      const endUser = await seedEndUser({ orgId: owner.orgId, spaceId: un });
      const headers = { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id };
      expect((await read(r.unOwner!, headers)).status).toBe(403);
      expect((await read(r.unOwner!, session(member), "?bogus=1")).status).toBe(400);
      expect((await read(r.unOwner!, session(member), "?wait=-1")).status).toBe(400);
    });
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
});
