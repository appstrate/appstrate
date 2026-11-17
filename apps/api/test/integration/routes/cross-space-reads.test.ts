// SPDX-License-Identifier: Apache-2.0

/**
 * The reach every list spanning the spaces of an organization shares
 * (`readAcrossSpaces`, `routes/cross-space-reads.ts`), one table over the
 * lists: which spaces a credential's rows come from. Each space holds one row
 * of every list, the owner's (and of the notification feed, one of the owner's and one of
 * the member's).
 *
 * | credential                                   | spaces read                                   |
 * | -------------------------------------------- | --------------------------------------------- |
 * | owner session                                | every team space (preset `admin`), private included |
 * | guest session, no row anywhere               | none: empty list, 200                          |
 * | owner session + `X-View-As: org_role=member` | the persona's reach (Default)                  |
 * | API key pinned to Un, the list's read scope  | Un only; another organization's path → 403     |
 * | API key without the list's read scope        | — 403 (ceiling guard)                          |
 * | API key + `Appstrate-User` (end-user)        | — 403, unknown query parameter included        |
 * | chat loopback bearer carrying every read     | the member session's reach (Un, Default)       |
 * | member session, unknown query parameter      | — 400                                          |
 * | any                                          | another organization → 403                     |
 *
 * The per-row rules of each list are in `org-{runs,schedules,files,packages}.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { files } from "@appstrate/db/schema";
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
  seedSchedule,
  seedSpace,
  seedSpaceGrant,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { memberLoopbackHeaders } from "../../helpers/loopback.ts";
import { createPackageShareNotification } from "../../../src/services/state/notifications.ts";

const app = getTestApp();

const SCOPE = "@orgreach";

/** Each list, with the permission its key is scoped to. */
const LISTS = [
  { list: "runs", read: "runs:read-all" },
  { list: "schedules", read: "schedules:read" },
  { list: "files", read: "files:read" },
  { list: "agents", read: "agents:read" },
  { list: "packages/skills", read: "skills:read" },
  { list: "packages/integrations", read: "integrations:read" },
  // The caller's own feed: its ceiling is a run read, and no space asks a role grant.
  { list: "notifications", read: "runs:read-all" },
] as const;
const EVERY_READ = [...LISTS.map(({ read }) => read), "runs:read"];

describe("lists spanning the organization's spaces: the shared reach", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let ferme: string;
  let prive: string;
  let foreignOrgId: string;

  /** One row of every list in `spaceId`, all of the owner's. */
  async function seedSpaceRows(spaceId: string) {
    const name = (kind: string) => `${SCOPE}/${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const agent = await seedPackage({
      id: name("agent"),
      orgId: owner.orgId,
      homeSpaceId: spaceId,
      createdBy: owner.user.id,
    });
    const skillId = name("skill");
    await seedPackage({
      id: skillId,
      orgId: owner.orgId,
      type: "skill",
      homeSpaceId: spaceId,
      createdBy: owner.user.id,
      draftManifest: { name: skillId, version: "0.1.0", type: "skill" },
    });
    const integrationId = name("integration");
    await seedPackage({
      id: integrationId,
      orgId: owner.orgId,
      type: "integration",
      homeSpaceId: spaceId,
      createdBy: owner.user.id,
      draftManifest: remoteIntegrationManifest({
        name: integrationId,
        auths: { api: { type: "api_key" } },
      }) as unknown as Record<string, unknown>,
    });
    for (const id of [agent.id, skillId, integrationId]) await seedSpacePackage(spaceId, id);
    await seedSchedule({
      packageId: agent.id,
      orgId: owner.orgId,
      spaceId,
      userId: owner.user.id,
    });
    const run = await seedRun({
      packageId: agent.id,
      orgId: owner.orgId,
      spaceId,
      userId: owner.user.id,
      status: "success",
      startedAt: new Date(),
    });
    const fileId = `file_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await db.insert(files).values({
      id: fileId,
      orgId: owner.orgId,
      spaceId,
      purpose: "agent_output",
      runId: run.id,
      userId: owner.user.id,
      storageKey: `files/${spaceId}/${fileId}/out.txt`,
      name: "out.txt",
      mime: "text/plain",
      size: 1,
      sha256: "0".repeat(64),
    });
    for (const recipient of [owner.user.id, member.user.id]) {
      await createPackageShareNotification({
        orgId: owner.orgId,
        spaceId,
        recipientUserId: recipient,
        packageId: agent.id,
        packageType: "agent",
        sharedByName: "Ada",
      });
    }
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgreach" });
    member = await memberContext(owner, "member");
    un = (await seedSpace({ orgId: owner.orgId, name: "Un", visibility: "closed" })).id;
    ferme = (await seedSpace({ orgId: owner.orgId, name: "Fermé", visibility: "closed" })).id;
    prive = (await seedSpace({ orgId: owner.orgId, name: "Privé", visibility: "private" })).id;
    await seedSpaceGrant({
      orgId: owner.orgId,
      spaceId: un,
      userId: member.user.id,
      permissions: EVERY_READ,
    });
    for (const spaceId of [owner.defaultSpaceId, un, ferme, prive]) await seedSpaceRows(spaceId);

    const foreign = await createTestContext({ orgSlug: "orgreach-foreign" });
    foreignOrgId = foreign.orgId;
    await addOrgMember(foreign.orgId, member.user.id, "member");
  });

  const path = (list: string, query = "", orgId = owner.orgId) =>
    `/api/orgs/${orgId}/${list}${query}`;
  const session = (ctx: TestContext, extra: Record<string, string> = {}) => ({
    Cookie: ctx.cookie,
    ...extra,
  });
  const keyFor = async (scopes: string[]) => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: un,
      createdBy: owner.user.id,
      scopes,
    });
    return { Authorization: `Bearer ${key.rawKey}` };
  };

  /** The spaces the seeded rows of `list` come from (system packages left out). */
  async function spacesOf(list: string, headers: Record<string, string>): Promise<string[]> {
    const res = await app.request(path(list), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: { id: string; spaceId?: string; space_ids?: string[] }[];
    };
    expect(body.object).toBe("list");
    const rows = body.data.filter((row) => !row.id.startsWith("@") || row.id.startsWith(SCOPE));
    // A package index names a package's spaces; every other list, a row's space.
    return [...new Set(rows.flatMap((row) => row.space_ids ?? [row.spaceId!]))].sort();
  }
  const sorted = (...ids: string[]) => ids.sort();

  for (const { list, read } of LISTS) {
    describe(`GET /api/orgs/{orgId}/${list}`, () => {
      it("serves the owner every team space, private included", async () => {
        expect(await spacesOf(list, session(owner))).toEqual(
          sorted(owner.defaultSpaceId, un, ferme, prive),
        );
      });

      it("serves a guest with no role an empty list", async () => {
        const guest = await createTestUser();
        await addOrgMember(owner.orgId, guest.id, "guest");
        expect(await spacesOf(list, { Cookie: guest.cookie })).toEqual([]);
      });

      it("answers the persona of a role preview, not the previewer", async () => {
        expect(await spacesOf(list, session(owner, { "X-View-As": "org_role=member" }))).toEqual([
          owner.defaultSpaceId,
        ]);
      });

      it("bounds a space-pinned API key to its space and its organization", async () => {
        const headers = await keyFor([read]);
        expect(await spacesOf(list, headers)).toEqual([un]);
        expect((await app.request(path(list, "", foreignOrgId), { headers })).status).toBe(403);
      });

      it("refuses an API key whose scopes hold no read of the list", async () => {
        const res = await app.request(path(list), { headers: await keyFor(["mcp:read"]) });
        expect(res.status).toBe(403);
      });

      it("refuses an end-user, whatever its query", async () => {
        const endUser = await seedEndUser({ orgId: owner.orgId, spaceId: un });
        const headers = { ...(await keyFor([read])), "Appstrate-User": endUser.id };
        expect((await app.request(path(list), { headers })).status).toBe(403);
        expect((await app.request(path(list, "?bogus=1"), { headers })).status).toBe(403);
      });

      it("reaches with the chat's loopback bearer what the member's session reaches", async () => {
        const viaSession = await spacesOf(list, session(member));
        expect(viaSession).toContain(un);
        expect(viaSession).not.toContain(ferme);
        expect(viaSession).not.toContain(prive);
        expect(
          await spacesOf(list, memberLoopbackHeaders(member, owner.orgId, EVERY_READ)),
        ).toEqual(viaSession);
      });

      it("refuses an unknown query parameter", async () => {
        const res = await app.request(path(list, `?spaceId=${un}`), { headers: session(member) });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
      });

      it("refuses an organization the caller is not a member of", async () => {
        const res = await app.request(path(list, "", foreignOrgId), { headers: session(owner) });
        expect(res.status).toBe(403);
      });
    });
  }
});
