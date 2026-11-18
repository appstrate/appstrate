// SPDX-License-Identifier: Apache-2.0

/**
 * The reach every read spanning the spaces of an organization shares
 * (`readAcrossSpaces` / `readOwnAcrossSpaces`, `routes/cross-space-reads.ts`),
 * one table over the lists and the single reads (one run, one notification,
 * one agent's memory): which spaces a credential's rows come from. Each space
 * holds one row of every list, the owner's (and of the notification feed, one
 * of the owner's and one of the member's), and a shared memory of one agent
 * placed in all of them. A single read answers 200 for a row of a space read,
 * 404 for any other.
 *
 * | credential                                   | spaces read                                   |
 * | -------------------------------------------- | --------------------------------------------- |
 * | owner session                                | every team space (preset `admin`), private included |
 * | guest session, no row anywhere               | none: empty list, 200 (single read: 404)       |
 * | owner session + `X-View-As: org_role=member` | the persona's reach (Default)                  |
 * | API key pinned to Un, the list's read scope  | Un only; another organization's path → 403     |
 * | API key without the list's read scope        | — 403 (ceiling guard)                          |
 * | API key + `Appstrate-User` (end-user)        | — 403, unknown query parameter included        |
 * | chat loopback bearer carrying every read     | the member session's reach (Un, Default)       |
 * | member session, unknown query parameter      | — 400                                          |
 * | any                                          | another organization → 403                     |
 *
 * The per-row rules of each read are in
 * `org-{runs,schedules,files,packages,notifications,agent-persistence}.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db } from "@appstrate/db/client";
import { files, notifications } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
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
import { addMemory } from "../../../src/services/state/package-persistence.ts";

const app = getTestApp();

const SCOPE = "@orgreach";
/** The agent placed in every space, one shared memory in each. */
const MEMORY_AGENT = `${SCOPE}/memory`;

/** Each read, with the permission its key is scoped to. */
const READS = [
  { list: "runs", read: "runs:read-all" },
  { list: "schedules", read: "schedules:read" },
  { list: "files", read: "files:read" },
  { list: "agents", read: "agents:read" },
  { list: "packages/skills", read: "skills:read" },
  { list: "packages/integrations", read: "integrations:read" },
  // The caller's own feed: its ceiling is a run read, and no space asks a role grant.
  { list: "notifications", read: "runs:read-all" },
  { list: "runs/{id}", read: "runs:read-all" },
  { list: "notifications/{id}", read: "runs:read-all" },
  { list: "agents/{scope}/{name}/persistence", read: "persistence:read" },
] as const;
const EVERY_READ = [...READS.map(({ read }) => read), "runs:read"];

describe("lists spanning the organization's spaces: the shared reach", () => {
  let owner: TestContext;
  let member: TestContext;
  let un: string;
  let ferme: string;
  let prive: string;
  let foreignOrgId: string;
  /** The seeded run of each space, and its notifications. */
  let runIn: Map<string, string>;
  let notificationsIn: Map<string, string[]>;

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
    runIn.set(spaceId, run.id);
    await seedSpacePackage(spaceId, MEMORY_AGENT);
    await addMemory(MEMORY_AGENT, spaceId, owner.orgId, { type: "shared" }, "memo", run.id);
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
    runIn = new Map();
    await seedPackage({
      id: MEMORY_AGENT,
      orgId: owner.orgId,
      homeSpaceId: owner.defaultSpaceId,
      createdBy: owner.user.id,
    });
    await seedSpaceGrant({
      orgId: owner.orgId,
      spaceId: un,
      userId: member.user.id,
      permissions: EVERY_READ,
    });
    for (const spaceId of [owner.defaultSpaceId, un, ferme, prive]) await seedSpaceRows(spaceId);
    notificationsIn = new Map();
    const seeded = await db
      .select({ id: notifications.id, spaceId: notifications.spaceId })
      .from(notifications)
      .where(eq(notifications.orgId, owner.orgId));
    for (const { id, spaceId } of seeded) {
      notificationsIn.set(spaceId, [...(notificationsIn.get(spaceId) ?? []), id]);
    }

    const foreign = await createTestContext({ orgSlug: "orgreach-foreign" });
    foreignOrgId = foreign.orgId;
    await addOrgMember(foreign.orgId, member.user.id, "member");
  });

  /** The path of `read`; a single run or notification is Un's. */
  const path = (read: string, query = "", orgId = owner.orgId) => {
    const target = read
      .replace("runs/{id}", `runs/${runIn.get(un)}`)
      .replace("notifications/{id}", `notifications/${notificationsIn.get(un)![0]}`)
      .replace("agents/{scope}/{name}", `agents/${MEMORY_AGENT}`);
    return `/api/orgs/${orgId}/${target}${query}`;
  };
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

  /** The spaces whose single row answers 200; every other answers 404. */
  async function spacesFound(
    rowsIn: Map<string, string[]>,
    pathOf: (id: string) => string,
    headers: Record<string, string>,
  ): Promise<string[]> {
    const found: string[] = [];
    for (const [spaceId, ids] of rowsIn) {
      for (const id of ids) {
        const status = (await app.request(pathOf(id), { headers })).status;
        expect([200, 404], `${pathOf(id)} → ${status}`).toContain(status);
        if (status === 200) found.push(spaceId);
      }
    }
    return [...new Set(found)].sort();
  }

  /** The spaces the seeded rows of `read` come from (system packages left out). */
  async function spacesOf(read: string, headers: Record<string, string>): Promise<string[]> {
    const org = `/api/orgs/${owner.orgId}`;
    if (read === "runs/{id}") {
      const rows = new Map([...runIn].map(([spaceId, id]) => [spaceId, [id]]));
      return spacesFound(rows, (id) => `${org}/runs/${id}`, headers);
    }
    if (read === "notifications/{id}") {
      return spacesFound(notificationsIn, (id) => `${org}/notifications/${id}`, headers);
    }
    if (read.endsWith("/persistence")) {
      const res = await app.request(path(read), { headers });
      // No space read places the agent: 404, never an empty body.
      if (res.status === 404) return [];
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { object: string; memories: { spaceId: string }[] };
      expect(body.object).toBe("agent_persistence");
      return [...new Set(body.memories.map((row) => row.spaceId))].sort();
    }
    const res = await app.request(path(read), { headers });
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

  for (const { list, read } of READS) {
    describe(`GET /api/orgs/{orgId}/${list}`, () => {
      it("serves the owner every team space, private included", async () => {
        expect(await spacesOf(list, session(owner))).toEqual(
          sorted(owner.defaultSpaceId, un, ferme, prive),
        );
      });

      it("reaches no space for a guest with no role", async () => {
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
