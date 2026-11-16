// SPDX-License-Identifier: Apache-2.0

/**
 * The package indexes spanning the spaces of an organization:
 * `GET /api/orgs/{orgId}/agents` and `GET /api/orgs/{orgId}/packages/{skills|integrations}`.
 * Each lists the single-space index's rows of every space the caller reaches
 * with the type's sight there, one row per (package, space) where it is active.
 *
 * | credential                                  | space (member's role)                                             | rows |
 * | ------------------------------------------- | ----------------------------------------------------------------- | ---- |
 * | member session                              | Un (`agents:read`, `agents:run`, `runs:read-all`, `skills:read`, `integrations:read`) | agent A with its dependencies and every running run; skill S1; integration I1 |
 * | member session                              | Deux (`agents:run` only)                                          | agents A and B, summary rows, own running run only; skill S2 not listed |
 * | member session                              | Trois (`skills:read`, `integrations:read`)                        | agent C not listed; skill S3; integration I2 |
 * | member session                              | Fermé (`closed`, not joined)                                      | nothing |
 * | owner session                               | every team space (preset `admin`)                                 | every row |
 * | API key pinned to Un, scopes `agents:read`  | Un only                                                           | agent A in Un |
 * | API key pinned to Deux, scopes `integrations:read` | Deux only, which grants no `integrations:read`             | empty list |
 * | chat loopback bearer, ceiling `agents:run`  | Un (`agents:read` capped away), Deux                              | summary rows everywhere |
 * | API key without the type's read in scopes   | —                                                                 | 403 (ceiling guard) |
 * | member session, unknown query parameter     | —                                                                 | 400 |
 * | API key + `Appstrate-User` (end-user)       | —                                                                 | 403 |
 * | API key of this organization                | another organization's path                                       | 403 |
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
  seedEndUser,
  seedPackage,
  seedRun,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import { remoteIntegrationManifest } from "../../helpers/integration-manifests.ts";
import { mintMcpLoopbackToken } from "../../../../../packages/module-chat/src/loopback-auth.ts";

const app = getTestApp();

const SCOPE = "@orgpkg";
const id = (name: string) => `${SCOPE}/${name}`;

interface Row {
  id: string;
  spaceId: string;
  running_runs?: number;
  dependencies?: Record<string, unknown>;
}

describe("package indexes across the organization's spaces", () => {
  let owner: TestContext;
  let member: TestContext;
  let s: Record<"un" | "deux" | "trois" | "ferme", string>;
  let foreignOrgId: string;

  async function join(spaceId: string, permissions: string[]) {
    const role = await seedSpaceRole({ orgId: owner.orgId, permissions });
    await seedSpaceMember({
      spaceId,
      userId: member.user.id,
      presetRole: null,
      customRoleId: role.id,
    });
  }

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
    await seedIndexed("i1", "integration", s.un, [s.un]);
    await seedIndexed("i2", "integration", s.trois, [s.trois]);

    const foreign = await createTestContext({ orgSlug: "orgpkg-foreign" });
    foreignOrgId = foreign.orgId;
    await addOrgMember(foreign.orgId, member.user.id, "member");
  });

  const path = (list: string, orgId = owner.orgId) => `/api/orgs/${orgId}/${list}`;

  /** The seeded rows of `list` (system packages left out), keyed `name@space`. */
  async function rows(list: string, headers: Record<string, string>) {
    const res = await app.request(path(list), { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { object: string; data: Row[]; hasMore: boolean };
    expect(body.object).toBe("list");
    expect(body.hasMore).toBe(false);
    const spaceKey = Object.fromEntries(Object.entries(s).map(([key, value]) => [value, key]));
    return Object.fromEntries(
      body.data
        .filter((row) => row.id.startsWith(`${SCOPE}/`))
        .map((row) => [`${row.id.slice(SCOPE.length + 1)}@${spaceKey[row.spaceId]}`, row]),
    );
  }
  const keys = async (list: string, headers: Record<string, string>) =>
    Object.keys(await rows(list, headers)).sort();
  const session = (ctx: TestContext) => ({ Cookie: ctx.cookie });

  it("lists each agent once per space it is active in, by the role held there", async () => {
    const agents = await rows("agents", session(member));
    expect(Object.keys(agents).sort()).toEqual(["a@deux", "a@un", "b@deux"]);
    // Un: `agents:read` and `runs:read-all`.
    expect(agents["a@un"]!.dependencies).toHaveProperty("skills");
    expect(agents["a@un"]!.running_runs).toBe(2);
    // Deux: `agents:run` alone is a summary read, counting the member's own run.
    expect(agents["a@deux"]!.dependencies).not.toHaveProperty("skills");
    expect(agents["a@deux"]!.dependencies).toHaveProperty("integrations");
    expect(agents["a@deux"]!.running_runs).toBe(1);
  });

  it("lists skills and integrations of the spaces granting their read", async () => {
    expect(await keys("packages/skills", session(member))).toEqual(["s1@un", "s3@trois"]);
    expect(await keys("packages/integrations", session(member))).toEqual(["i1@un", "i2@trois"]);
  });

  it("serves the owner every row of every team space", async () => {
    expect(await keys("agents", session(owner))).toEqual([
      "a@deux",
      "a@un",
      "b@deux",
      "c@trois",
      "d@ferme",
    ]);
    expect(await keys("packages/skills", session(owner))).toEqual(["s1@un", "s2@deux", "s3@trois"]);
  });

  it("orders the rows as the single-space index, a package's spaces side by side", async () => {
    const res = await app.request(path("agents"), { headers: session(owner) });
    const body = (await res.json()) as { data: Row[] };
    const seeded = body.data.filter((row) => row.id.startsWith(`${SCOPE}/`));
    const [first, second] = [s.un, s.deux].sort() as [string, string];
    expect(seeded.map((row) => [row.id, row.spaceId])).toEqual([
      [id("a"), first],
      [id("a"), second],
      [id("b"), s.deux],
      [id("c"), s.trois],
      [id("d"), s.ferme],
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
    const token = mintMcpLoopbackToken({
      userId: member.user.id,
      email: member.user.email,
      name: member.user.name,
      orgId: owner.orgId,
      orgRole: "member",
      permissions: ["agents:run", "runs:read"],
    });
    const agents = await rows("agents", {
      Authorization: `Bearer ${token}`,
      "X-Org-Id": owner.orgId,
    });
    expect(Object.keys(agents).sort()).toEqual(["a@deux", "a@un", "b@deux"]);
    // Un grants `agents:read`, `agents:run` and `runs:read-all`; the ceiling
    // keeps `agents:run` alone of them.
    expect(agents["a@un"]!.dependencies).not.toHaveProperty("skills");
    expect(agents["a@un"]!.running_runs).toBe(1);
  });

  it("refuses an unknown query parameter", async () => {
    for (const list of ["agents", "packages/skills", "packages/integrations"]) {
      const res = await app.request(path(`${list}?spaceId=${s.un}`), { headers: session(member) });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
    }
  });

  it("bounds a space-pinned API key to its space", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.un,
      createdBy: owner.user.id,
      scopes: ["agents:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    expect(await keys("agents", headers)).toEqual(["a@un"]);
    const otherOrg = await app.request(path("agents", foreignOrgId), { headers });
    expect(otherOrg.status).toBe(403);
  });

  it("refuses an API key whose scopes hold no read of the type", async () => {
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.un,
      createdBy: owner.user.id,
      scopes: ["runs:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}` };
    for (const list of ["agents", "packages/skills", "packages/integrations"]) {
      expect((await app.request(path(list), { headers })).status).toBe(403);
    }
  });

  it("refuses an end-user", async () => {
    const endUser = await seedEndUser({ orgId: owner.orgId, spaceId: s.un });
    const key = await seedApiKey({
      orgId: owner.orgId,
      spaceId: s.un,
      createdBy: owner.user.id,
      scopes: ["agents:read", "skills:read"],
    });
    const headers = { Authorization: `Bearer ${key.rawKey}`, "Appstrate-User": endUser.id };
    for (const list of ["agents", "packages/skills"]) {
      expect((await app.request(path(list), { headers })).status).toBe(403);
    }
  });

  it("stamps the single-space index rows with their space", async () => {
    const res = await app.request("/api/agents", {
      headers: { Cookie: owner.cookie, "X-Org-Id": owner.orgId, "X-Space-Id": s.deux },
    });
    const body = (await res.json()) as { data: Row[] };
    const seeded = body.data.filter((row) => row.id.startsWith(`${SCOPE}/`));
    expect(seeded.map((row) => row.spaceId)).toEqual([s.deux, s.deux]);
  });
});
