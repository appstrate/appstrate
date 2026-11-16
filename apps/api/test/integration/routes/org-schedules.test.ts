// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/orgs/{orgId}/schedules` — the schedules of every space where the
 * caller holds `schedules:read`; each schedule's run counters span the runs the
 * caller reads in ITS space.
 *
 * Every space holds one schedule of the owner's, which fired twice: one running
 * run launched by the owner, one running run launched by the member.
 *
 * | credential                                   | space (role)                                          | schedules | `running_runs` |
 * | -------------------------------------------- | ----------------------------------------------------- | --------- | -------------- |
 * | member session                               | Un (`schedules:read` + `runs:read-all`)               | listed    | 2 (every run)  |
 * | member session                               | Deux (`schedules:read` only)                          | listed    | 1 (own run)    |
 * | member session                               | Trois (`runs:read-all`, no `schedules:read`)          | none      | —              |
 * | member session                               | Default (open, implicit `operator`)                   | listed    | 1 (own run)    |
 * | member session                               | Fermé (`closed`, not joined) / Privé (not a member)   | none      | —              |
 * | owner session                                | every team space (preset `admin`)                     | all       | 2 everywhere   |
 * | API key pinned to Un, scopes `schedules:read`| Un only, ceiling applied                              | Un        | 1 (own run)    |
 * | chat loopback bearer (user, ceiling)         | the session's reach, capped by the ceiling            | ceiling without `runs:read-all` → Un counts own run only | |
 *
 * The reach every list shares is in `cross-space-reads.test.ts`; the MCP door
 * in `modules/mcp/test/integration/org-reads.test.ts`.
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
import {
  seedApiKey,
  seedPackage,
  seedRun,
  seedSchedule,
  seedSpace,
  seedSpaceGrant,
} from "../../helpers/seed.ts";
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

interface ListedSchedule {
  id: string;
  spaceId: string;
  agent_name: string;
  running_runs: number;
}

describe("GET /api/orgs/{orgId}/schedules", () => {
  let owner: TestContext;
  let member: TestContext;
  let s: Record<"un" | "deux" | "trois" | "ferme" | "prive", string>;
  /** Schedule ids by space key (`default` included). */
  let sched: Record<string, string>;
  let foreignSchedule: string;

  async function seedFiredSchedule(spaceId: string, orgId = owner.orgId, userId = owner.user.id) {
    const id = `@orgsched/agent-${crypto.randomUUID().slice(0, 8)}`;
    const pkg = await seedPackage({
      id,
      orgId,
      homeSpaceId: spaceId,
      createdBy: userId,
      draftManifest: {
        name: id,
        display_name: `Agent of ${spaceId}`,
        version: "0.1.0",
        type: "agent",
      },
    });
    const schedule = await seedSchedule({
      packageId: pkg.id,
      orgId,
      spaceId,
      userId,
      name: `in ${spaceId}`,
    });
    for (const launcher of orgId === owner.orgId ? [owner.user.id, member.user.id] : [userId]) {
      await seedRun({
        packageId: pkg.id,
        scheduleId: schedule.id,
        orgId,
        spaceId,
        userId: launcher,
        status: "running",
        startedAt: new Date(),
      });
    }
    return schedule.id;
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgsched" });
    member = await memberContext(owner, "member");
    const space = async (name: string, visibility: "closed" | "private" = "closed") =>
      (await seedSpace({ orgId: owner.orgId, name, visibility })).id;
    s = {
      un: await space("Un"),
      deux: await space("Deux"),
      trois: await space("Trois"),
      ferme: await space("Fermé"),
      prive: await space("Privé", "private"),
    };
    const join = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await join(s.un, ["schedules:read", "runs:read-all"]);
    await join(s.deux, ["schedules:read"]);
    await join(s.trois, ["runs:read-all"]);
    sched = { default: await seedFiredSchedule(owner.defaultSpaceId) };
    for (const [key, spaceId] of Object.entries(s)) sched[key] = await seedFiredSchedule(spaceId);

    const foreign = await createTestContext({ orgSlug: "orgsched-foreign" });
    await addOrgMember(foreign.orgId, member.user.id, "member");
    foreignSchedule = await seedFiredSchedule(
      foreign.defaultSpaceId,
      foreign.orgId,
      foreign.user.id,
    );
  });

  const path = (query = "") => `/api/orgs/${owner.orgId}/schedules${query}`;

  /** `running_runs` by schedule id. */
  async function list(headers: Record<string, string>, query = "") {
    const res = await app.request(path(query), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { object: string; data: ListedSchedule[]; hasMore: boolean };
    expect(body.object).toBe("list");
    expect(body.hasMore).toBe(false);
    return {
      counters: Object.fromEntries(body.data.map((row) => [row.id, row.running_runs])),
      body,
    };
  }
  const expected = (entries: Record<string, number>) =>
    Object.fromEntries(Object.entries(entries).map(([key, n]) => [sched[key]!, n]));

  it("serves each space's schedules with counters its role there grants", async () => {
    const { counters, body } = await list({ Cookie: member.cookie });
    expect(counters).toEqual(expected({ un: 2, deux: 1, default: 1 }));
    expect(counters[foreignSchedule]).toBeUndefined();
    const byId = new Map(body.data.map((row) => [row.id, row]));
    expect(byId.get(sched.un!)!.spaceId).toBe(s.un);
    expect(byId.get(sched.deux!)!.spaceId).toBe(s.deux);
    // The agent's display name rides on the row, whatever space places it.
    expect(byId.get(sched.deux!)!.agent_name).toBe(`Agent of ${s.deux}`);
  });

  it("names the agent by its package id when its manifest carries no display_name", async () => {
    const pkgId = `@orgsched/bare-${crypto.randomUUID().slice(0, 8)}`;
    await seedPackage({
      id: pkgId,
      orgId: owner.orgId,
      homeSpaceId: s.un,
      createdBy: owner.user.id,
      draftManifest: { name: pkgId, version: "0.1.0", type: "agent" },
    });
    const bare = await seedSchedule({
      packageId: pkgId,
      orgId: owner.orgId,
      spaceId: s.un,
      userId: owner.user.id,
    });
    const { body } = await list({ Cookie: member.cookie });
    expect(body.data.find((row) => row.id === bare.id)!.agent_name).toBe(pkgId);
  });

  it("counts every run of every schedule for the owner", async () => {
    expect((await list({ Cookie: owner.cookie })).counters).toEqual(
      expected({ default: 2, un: 2, deux: 2, trois: 2, ferme: 2, prive: 2 }),
    );
  });

  it("caps a space-pinned API key's counters with its scopes", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.un,
      createdBy: owner.user.id,
      scopes: ["schedules:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    // The creator's own run only: `runs:read-all` is outside the key's scopes.
    expect((await list(headers)).counters).toEqual(expected({ un: 1 }));
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
    expect((await list(loopback(["schedules:read", "runs:read-all"]))).counters).toEqual(
      expected({ un: 2, deux: 1, default: 1 }),
    );
    expect((await list(loopback(["schedules:read"]))).counters).toEqual(
      expected({ un: 1, deux: 1, default: 1 }),
    );
  });
});
