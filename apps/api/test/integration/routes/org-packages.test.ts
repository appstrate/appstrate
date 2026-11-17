// SPDX-License-Identifier: Apache-2.0

/**
 * The package indexes spanning the spaces of an organization:
 * `GET /api/orgs/{orgId}/agents` and `GET /api/orgs/{orgId}/packages/{skills|integrations}`.
 * Each lists one row per package active in a space the caller reaches with the
 * type's sight there, `space_ids` naming those spaces: the home first when it
 * is one of them, then in the order of `GET /api/spaces`.
 *
 * | credential                                  | space (member's role)                                             | rows |
 * | ------------------------------------------- | ----------------------------------------------------------------- | ---- |
 * | member session                              | Un (`agents:read`, `agents:run`, `runs:read-all`, `skills:read`, `integrations:read`) | agent A with its dependencies, counting every running run; skills S1, S4; integration I1 |
 * | member session                              | Deux (`agents:run` only)                                          | agents A and B, counting the member's own runs; B a summary row; skills S2, S4 not from here |
 * | member session                              | Trois (`skills:read`, `integrations:read`)                        | agent C not listed; skills S3, S4; integration I2 |
 * | member session                              | Fermé (`closed`, not joined)                                      | nothing |
 * | owner session                               | every team space (preset `admin`)                                 | every package, every space it is active in |
 * | API key pinned to Deux, scopes `integrations:read` | Deux only, which grants no `integrations:read`             | empty list |
 * | chat loopback bearer, ceiling `agents:run`  | Un (`agents:read` capped away), Deux                              | summary rows, own runs everywhere |
 *
 * The reach every list shares is in `cross-space-reads.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedApiKey,
  seedPackage,
  seedRun,
  seedSpace,
  seedSpacePackage,
  seedSpaceGrant,
} from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { memberLoopbackHeaders } from "../../helpers/loopback.ts";

const app = getTestApp();

const SCOPE = "@orgpkg";
const id = (name: string) => `${SCOPE}/${name}`;

interface Row {
  id: string;
  space_ids: string[];
  running_runs?: number;
  dependencies?: Record<string, unknown>;
}

describe("package indexes across the organization's spaces", () => {
  let owner: TestContext;
  let member: TestContext;
  let s: Record<"un" | "deux" | "trois" | "ferme", string>;

  /** A package homed in `home` and active in each of `activeIn`. */
  async function seedIndexed(
    name: string,
    type: "agent" | "skill" | "integration",
    home: string,
    activeIn: string[],
  ) {
    const pkgId = id(name);
    const draftManifest =
      type === "integration"
        ? (remoteIntegrationManifest({
            name: pkgId,
            auths: { api: { type: "api_key" } },
          }) as unknown as Record<string, unknown>)
        : {
            name: pkgId,
            version: "0.1.0",
            type,
            ...(type === "agent" ? { dependencies: { skills: { [id("s1")]: "^0.1.0" } } } : {}),
          };
    await seedPackage({
      id: pkgId,
      orgId: owner.orgId,
      type,
      homeSpaceId: home,
      createdBy: owner.user.id,
      draftManifest,
    });
    for (const spaceId of activeIn) await seedSpacePackage(spaceId, pkgId);
  }

  async function seedRunning(spaceId: string, agent: string, userId: string) {
    await seedRun({
      packageId: id(agent),
      orgId: owner.orgId,
      spaceId,
      userId,
      status: "running",
      startedAt: new Date(),
    });
  }

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "orgpkg" });
    member = await memberContext(owner, "member");
    const space = async (name: string) =>
      (await seedSpace({ orgId: owner.orgId, name, visibility: "closed" })).id;
    s = {
      un: await space("Un"),
      deux: await space("Deux"),
      trois: await space("Trois"),
      ferme: await space("Fermé"),
    };
    const join = (spaceId: string, permissions: string[]) =>
      seedSpaceGrant({ orgId: owner.orgId, spaceId, userId: member.user.id, permissions });
    await join(s.un, [
      "agents:read",
      "agents:run",
      "runs:read-all",
      "skills:read",
      "integrations:read",
    ]);
    await join(s.deux, ["agents:run"]);
    await join(s.trois, ["skills:read", "integrations:read"]);

    await seedIndexed("a", "agent", s.un, [s.un, s.deux]);
    await seedIndexed("b", "agent", s.deux, [s.deux]);
    await seedIndexed("c", "agent", s.trois, [s.trois]);
    await seedIndexed("d", "agent", s.ferme, [s.ferme]);
    for (const spaceId of [s.un, s.deux]) {
      await seedRunning(spaceId, "a", owner.user.id);
      await seedRunning(spaceId, "a", member.user.id);
    }

    await seedIndexed("s1", "skill", s.un, [s.un]);
    await seedIndexed("s2", "skill", s.deux, [s.deux]);
    await seedIndexed("s3", "skill", s.trois, [s.trois]);
    // Homed in Deux, where the member reads no skill; active in Un and Trois too.
    await seedIndexed("s4", "skill", s.deux, [s.un, s.deux, s.trois]);
    await seedIndexed("i1", "integration", s.un, [s.un]);
    await seedIndexed("i2", "integration", s.trois, [s.trois]);
  });

  const path = (list: string) => `/api/orgs/${owner.orgId}/${list}`;

  /** The seeded rows of `list` (system packages left out), keyed by name, in the order served. */
  async function rows(list: string, headers: Record<string, string>) {
    const res = await app.request(path(list), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { object: string; data: Row[]; hasMore: boolean };
    expect(body.object).toBe("list");
    expect(body.hasMore).toBe(false);
    return Object.fromEntries(
      body.data
        .filter((row) => row.id.startsWith(`${SCOPE}/`))
        .map((row) => [row.id.slice(SCOPE.length + 1), row]),
    );
  }
  /** Each seeded package's spaces, by name. */
  const spacesOf = async (list: string, headers: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(await rows(list, headers)).map(([name, row]) => [name, row.space_ids]),
    );
  const session = (ctx: TestContext) => ({ Cookie: ctx.cookie });

  /** `ids` in the order of `ctx`'s space listing. */
  async function inListingOrder(ctx: TestContext, ids: string[]) {
    const res = await app.request("/api/spaces", {
      headers: { Cookie: ctx.cookie, "X-Org-Id": owner.orgId },
    });
    const listing = ((await res.json()) as { data: { id: string }[] }).data.map((sp) => sp.id);
    expect(ids.every((spaceId) => listing.includes(spaceId))).toBe(true);
    return listing.filter((spaceId) => ids.includes(spaceId));
  }

  it("names on the agent detail the spaces its index row names", async () => {
    const detail = async (spaceId: string) => {
      const res = await app.request(`/api/packages/agents/${id("a")}`, {
        headers: { ...session(member), "X-Org-Id": owner.orgId, "X-Space-Id": spaceId },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json()) as { active: boolean; space_ids: string[] };
    };
    expect((await detail(s.deux)).space_ids).toEqual(
      (await rows("agents", session(member))).a!.space_ids,
    );
    // Switched off in the space read from: still readable there, no longer named.
    await seedSpacePackage(s.deux, id("a"), { enabled: false });
    const off = await detail(s.deux);
    expect(off.active).toBe(false);
    expect(off.space_ids).toEqual([s.un]);
  });

  it("names on the skill and integration details the spaces their index rows name", async () => {
    const detail = async (segment: string, name: string, spaceId: string) => {
      const res = await app.request(`/api/packages/${segment}/${id(name)}`, {
        headers: { ...session(member), "X-Org-Id": owner.orgId, "X-Space-Id": spaceId },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { space_ids: string[] }).space_ids;
    };
    const skills = await rows("packages/skills", session(member));
    const integrations = await rows("packages/integrations", session(member));
    // Homed in Deux, where the member reads no skill: Deux is not named.
    expect(await detail("skills", "s4", s.un)).toEqual(skills.s4!.space_ids);
    expect(await detail("integrations", "i1", s.un)).toEqual(integrations.i1!.space_ids);
    // Switched off in the space read from: still readable there, no longer named.
    await seedSpacePackage(s.un, id("s4"), { enabled: false });
    expect(await detail("skills", "s4", s.un)).toEqual([s.trois]);
  });

  it("lists each agent once, its spaces read, its counters over them", async () => {
    const agents = await rows("agents", session(member));
    expect(Object.keys(agents).sort()).toEqual(["a", "b"]);
    expect(agents.a!.space_ids).toEqual([s.un, s.deux]);
    expect(agents.b!.space_ids).toEqual([s.deux]);
    // Un grants `agents:read`: the content is the same package wherever it is read.
    expect(agents.a!.dependencies).toHaveProperty("skills");
    // Deux alone: `agents:run` is a summary read.
    expect(agents.b!.dependencies).not.toHaveProperty("skills");
    expect(agents.b!.dependencies).toHaveProperty("integrations");
    // Un counts both running runs (`runs:read-all`), Deux the member's own.
    expect(agents.a!.running_runs).toBe(3);
  });

  it("lists skills and integrations of the spaces granting their read, those spaces only", async () => {
    expect(await spacesOf("packages/skills", session(member))).toEqual({
      s1: [s.un],
      s3: [s.trois],
      // Active in three spaces, read in two of them: its home, Deux, is not named.
      s4: await inListingOrder(member, [s.un, s.trois]),
    });
    expect(await spacesOf("packages/integrations", session(member))).toEqual({
      i1: [s.un],
      i2: [s.trois],
    });
  });

  it("names the home first, then the spaces in the order of the space listing", async () => {
    const skills = await spacesOf("packages/skills", session(owner));
    expect(skills.s4).toEqual([s.deux, ...(await inListingOrder(owner, [s.un, s.trois]))]);
  });

  it("orders the packages as the single-space index, each once", async () => {
    const res = await app.request(path("agents"), { headers: session(owner) });
    const body = (await res.json()) as { data: Row[] };
    const seeded = body.data.filter((row) => row.id.startsWith(`${SCOPE}/`));
    expect(seeded.map((row) => [row.id, row.space_ids])).toEqual([
      [id("a"), [s.un, ...(await inListingOrder(owner, [s.deux]))]],
      [id("b"), [s.deux]],
      [id("c"), [s.trois]],
      [id("d"), [s.ferme]],
    ]);
  });

  it("answers 200 with an empty list where no reached space admits the list", async () => {
    // Pinned to Deux, where the member holds `agents:run` only: the ceiling
    // passes, the one space reached grants no `integrations:read`.
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.deux,
      createdBy: member.user.id,
      scopes: ["integrations:read"],
    });
    const res = await app.request(path("packages/integrations"), {
      headers: { Authorization: `Bearer ${key.rawKey}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Row[] }).data).toEqual([]);
  });

  it("serves summary rows to a credential whose ceiling omits agents:read", async () => {
    const agents = await rows(
      "agents",
      memberLoopbackHeaders(member, owner.orgId, ["agents:run", "runs:read"]),
    );
    expect(Object.keys(agents).sort()).toEqual(["a", "b"]);
    expect(agents.a!.space_ids).toEqual([s.un, s.deux]);
    // Un grants `agents:read`, `agents:run` and `runs:read-all`; the ceiling
    // keeps `agents:run` alone of them: a summary, the member's own runs in each space.
    expect(agents.a!.dependencies).not.toHaveProperty("skills");
    expect(agents.a!.running_runs).toBe(2);
  });

  it("names the request's space on the single-space index rows", async () => {
    const res = await app.request("/api/agents", {
      headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId, "X-Space-Id": s.deux },
    });
    const body = (await res.json()) as { data: Row[] };
    const seeded = body.data.filter((row) => row.id.startsWith(`${SCOPE}/`));
    expect(seeded.map((row) => row.space_ids)).toEqual([[s.deux], [s.deux]]);
  });
});
