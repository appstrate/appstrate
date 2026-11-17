// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/notifications` and its unread count — the caller's own
 * notifications in every space they hold a role in, the rule of the space feed
 * applied in each.
 *
 * | space                                    | notification of     | listed |
 * | ---------------------------------------- | ------------------- | ------ |
 * | open default space (default role)        | the member          | yes    |
 * | closed space joined as `viewer` (Un)     | the member          | yes    |
 * | closed space joined as `viewer` (Un)     | the owner           | no     |
 * | `closed` space, not joined (Fermé)       | the member          | no     |
 * | another organization's space             | the member          | no     |
 *
 * One notification is read in whichever space holds it through
 * `GET /api/orgs/{orgId}/notifications/{id}`, and marked read in its own space
 * through the space routes; the reach every org list shares is in
 * `cross-space-reads.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  createTestContext,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedApiKey, seedEndUser, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";
import { walkLinkPages } from "../../helpers/pagination.ts";
import { db } from "@appstrate/db/client";
import { notifications } from "@appstrate/db/schema";

const app = getTestApp();

interface ListedNotification {
  id: string;
  spaceId: string;
  type: string;
}

describe("GET /api/orgs/{orgId}/notifications", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let ferme: string;
  /** Notification ids by space and recipient. */
  let n: Record<string, string>;

  async function share(spaceId: string, userId: string, orgId = owner.orgId): Promise<string> {
    const [row] = await db
      .insert(notifications)
      .values({
        orgId,
        spaceId,
        recipientId: userId,
        recipientType: "user",
        type: "package_shared",
        payload: { packageId: "@orgnotif/pkg", package_type: "skill", shared_by_name: "Ada" },
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgnotif" });
    member = await memberContext(owner, "member");
    un = (await seedSpace({ orgId: owner.orgId, name: "Un", visibility: "closed" })).id;
    ferme = (await seedSpace({ orgId: owner.orgId, name: "Fermé", visibility: "closed" })).id;
    await seedSpaceMember({ spaceId: un, userId: member.user.id, presetRole: "viewer" });
    n = {
      defaultMember: await share(owner.defaultSpaceId, member.user.id),
      unMember: await share(un, member.user.id),
      unOwner: await share(un, owner.user.id),
      fermeMember: await share(ferme, member.user.id),
    };
    const foreign = await createTestContext({ orgSlug: "orgnotif-foreign" });
    await addOrgMember(foreign.orgId, member.user.id, "member");
    n.foreign = await share(foreign.defaultSpaceId, member.user.id, foreign.orgId);
  });

  const session = (ctx: TestContext) => ({ Cookie: ctx.cookie });
  const listPath = (query = "") => `/api/orgs/${owner.orgId}/notifications${query}`;

  async function list(ctx: TestContext, query = ""): Promise<ListedNotification[]> {
    const res = await app.request(listPath(query), { headers: session(ctx) });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: ListedNotification[] }).data;
  }

  async function orgUnreadCount(ctx: TestContext): Promise<number> {
    const res = await app.request(`/api/orgs/${owner.orgId}/notifications/unread-count`, {
      headers: session(ctx),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { count: number }).count;
  }

  const inSpace = (ctx: TestContext, spaceId: string) => ({
    Cookie: ctx.cookie,
    "X-Org-Id": owner.orgId,
    "X-Space-Id": spaceId,
  });

  it("lists the caller's own notifications of every space they hold a role in, each naming its space", async () => {
    const rows = await list(member);
    expect(await orgUnreadCount(member)).toBe(2);
    expect(new Map(rows.map((row) => [row.id, row.spaceId]))).toEqual(
      new Map([
        [n.defaultMember!, owner.defaultSpaceId],
        [n.unMember!, un],
      ]),
    );
  });

  it("pages across spaces with the space feed's cursor", async () => {
    const pages = await walkLinkPages<{ data: ListedNotification[] }>(
      app,
      listPath("?limit=1"),
      session(member),
    );
    expect(pages.flatMap((page) => page.data.map((row) => row.id)).sort()).toEqual(
      [n.defaultMember!, n.unMember!].sort(),
    );
  });

  it("filters to unread, and a notification marked read in its own space leaves the count", async () => {
    const res = await app.request(`/api/notifications/${n.unMember}/read`, {
      method: "PUT",
      headers: inSpace(member, un),
    });
    expect(res.status).toBe(204);
    expect(await orgUnreadCount(member)).toBe(1);
    expect((await list(member, "?unread=true")).map((row) => row.id)).toEqual([n.defaultMember!]);
  });

  it("reads one notification in its own space only", async () => {
    const own = await app.request(`/api/notifications/${n.unMember}`, {
      headers: inSpace(member, un),
    });
    expect(own.status).toBe(200);
    expect(((await own.json()) as ListedNotification).spaceId).toBe(un);
    const elsewhere = await app.request(`/api/notifications/${n.unMember}`, {
      headers: inSpace(member, owner.defaultSpaceId),
    });
    expect(elsewhere.status).toBe(404);
  });

  it("« Tout marquer comme lu » in one space reads that space's feed only", async () => {
    const res = await app.request("/api/notifications/read-all", {
      method: "PUT",
      headers: inSpace(member, un),
    });
    expect(((await res.json()) as { updated_count: number }).updated_count).toBe(1);
    expect(await orgUnreadCount(member)).toBe(1);
  });

  it("gives the owner their own notifications only, never a member's", async () => {
    const rows = await list(owner);
    expect(rows.map((row) => row.id)).toEqual([n.unOwner!]);
  });

  describe("the cursor and the query", () => {
    it("answers an empty page for a cursor that is not an id", async () => {
      expect(await list(member, "?startingAfter=not-a-uuid")).toEqual([]);
    });

    it("answers an empty page for a cursor of a space outside the reach", async () => {
      // Fermé's notification is the newest: a cursor resolved outside the reach would page
      // past it onto the member's two older ones.
      expect(await list(member, `?startingAfter=${n.fermeMember}`)).toEqual([]);
    });

    it("refuses an `unread` that is neither true nor false, and an unknown parameter", async () => {
      for (const query of ["?unread=1", "?bogus=1"]) {
        const res = await app.request(listPath(query), { headers: session(member) });
        expect(res.status, query).toBe(400);
      }
      const count = await app.request(
        `/api/orgs/${owner.orgId}/notifications/unread-count?bogus=1`,
        { headers: session(member) },
      );
      expect(count.status).toBe(400);
    });
  });

  it("answers a role preview with the persona's reach, the previewer's own notifications", async () => {
    const ownDefault = await share(owner.defaultSpaceId, owner.user.id);
    const res = await app.request(listPath(), {
      headers: { ...session(owner), "X-View-As": "org_role=member" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = ((await res.json()) as { data: ListedNotification[] }).data;
    // Un is closed and the persona joined none of it: its notification is out of reach.
    expect(rows.map((row) => row.id)).toEqual([ownDefault]);
  });

  describe("GET /api/orgs/{orgId}/notifications/{id}", () => {
    const onePath = (id: string) => `/api/orgs/${owner.orgId}/notifications/${id}`;
    const status = async (id: string, headers: Record<string, string>) =>
      (await app.request(onePath(id), { headers })).status;

    const pinnedKey = async () => {
      const key = await seedApiKey({
        orgId: owner.orgId,
        spaceId: un,
        createdBy: owner.user.id,
        scopes: ["runs:read"],
      });
      return { Authorization: `Bearer ${key.rawKey}` };
    };

    it("finds the caller's notification in whichever space holds it", async () => {
      const res = await app.request(onePath(n.unMember!), { headers: session(member) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListedNotification;
      expect(body).toMatchObject({ id: n.unMember, spaceId: un, type: "package_shared" });
    });

    it("answers 404 for a space not reached, another recipient's, and an id that is none", async () => {
      expect(await status(n.fermeMember!, session(member))).toBe(404);
      expect(await status(n.foreign!, session(member))).toBe(404);
      expect(await status(n.unOwner!, session(member))).toBe(404);
      expect(await status("not-a-uuid", session(member))).toBe(404);
    });

    it("bounds a space-pinned API key to its space", async () => {
      const ownDefault = await share(owner.defaultSpaceId, owner.user.id);
      const headers = await pinnedKey();
      expect(await status(n.unOwner!, headers)).toBe(200);
      expect(await status(ownDefault, headers)).toBe(404);
    });

    it("answers a role preview with the persona's reach", async () => {
      const ownDefault = await share(owner.defaultSpaceId, owner.user.id);
      const headers = { ...session(owner), "X-View-As": "org_role=member" };
      expect(await status(ownDefault, headers)).toBe(200);
      expect(await status(n.unOwner!, headers)).toBe(404);
    });

    it("refuses an end-user", async () => {
      const endUser = await seedEndUser({ orgId: owner.orgId, spaceId: un });
      const headers = { ...(await pinnedKey()), "Appstrate-User": endUser.id };
      expect(await status(n.unOwner!, headers)).toBe(403);
    });
  });
});
