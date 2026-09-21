// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the space-package WRITE surface — activate, configure, deactivate.
 *
 * The permission is the SPACE-level string for the package type, never the
 * org-level `spaces:write` (the catalog verb that creates and deletes spaces),
 * so each case below is a pair: the same caller, the same package, two spaces
 * that differ only by the role they hold there.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  memberContext,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedSpacePackage,
  seedPackageShare,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";

const app = getTestApp();

describe("space package activate/configure/deactivate — permission is per package type", () => {
  let owner: TestContext;
  /** Org `member`, preset `admin` in `runs`, implicit `operator` in `visits`. */
  let spaceAdmin: TestContext;
  let runs: Awaited<ReturnType<typeof seedSpace>>;
  let visits: Awaited<ReturnType<typeof seedSpace>>;

  const AGENT = "@testorg/install-gate-agent";
  const SKILL = "@testorg/install-gate-skill";

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext();
    runs = await seedSpace({ orgId: owner.orgId, name: "Runs" });
    visits = await seedSpace({ orgId: owner.orgId, name: "Visits" });
    // Homed in the default space, and OFFERED to both target spaces. The offer
    // is what places a package in a space it does not live in (RBAC spec §6.9);
    // this suite is about the activation GRANT on top of that placement, so the
    // placement is fixture rather than subject. Without it every activation
    // here would answer 404 for want of an audience decision, and the grant
    // under test would never be reached.
    for (const id of [AGENT, SKILL]) {
      await seedPackage({
        orgId: owner.orgId,
        id,
        type: id === AGENT ? "agent" : "skill",
        homeSpaceId: owner.defaultSpaceId,
      });
      await seedPackageShare(runs.id, id);
      await seedPackageShare(visits.id, id);
    }

    spaceAdmin = await memberContext(owner, "member");
    await seedSpaceMember({ spaceId: runs.id, userId: spaceAdmin.user.id, presetRole: "admin" });
  });

  async function activate(ctx: TestContext, spaceId: string, packageId: string): Promise<Response> {
    return app.request(`/api/spaces/${spaceId}/packages`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ packageId }),
    });
  }

  it("a space admin activates an agent in their space and nowhere else", async () => {
    // `agents:configure` comes from the preset `admin` row in `runs`.
    expect((await activate(spaceAdmin, runs.id, AGENT)).status).toBe(201);

    // Same caller, same agent, the space where they are only an implicit
    // `operator` — which carries `agents:read`/`agents:run` and no `configure`.
    const denied = await activate(spaceAdmin, visits.id, AGENT);
    expect(denied.status).toBe(403);

    // Control: the owner installs into that same space, so the 403 is about
    // the caller's role there and not about the space or the package.
    expect((await activate(owner, visits.id, AGENT)).status).toBe(201);
  });

  it("selects the resource by package type, not one string for all of them", async () => {
    // No preset separates the two — `builder` and above hold both — so the
    // discriminating caller can read both types but only write skills.
    // Same caller, same space, two package types, two answers.
    const skillsOnly = await seedSpaceRole({
      orgId: owner.orgId,
      key: "skills-only",
      permissions: ["skills:read", "skills:write", "agents:read"],
    });
    const asAuthor = await memberContext(owner, "member");
    await seedSpaceMember({
      spaceId: visits.id,
      userId: asAuthor.user.id,
      presetRole: null,
      customRoleId: skillsOnly.id,
    });

    expect((await activate(asAuthor, visits.id, SKILL)).status).toBe(201);
    expect((await activate(asAuthor, visits.id, AGENT)).status).toBe(403);
  });

  it("deactivate and configure read the same per-type permission", async () => {
    await seedSpacePackage(runs.id, AGENT);
    await seedSpacePackage(visits.id, AGENT);

    const configure = (spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/packages/${AGENT}`, {
        method: "PUT",
        headers: authHeaders(spaceAdmin, { "Content-Type": "application/json" }),
        body: JSON.stringify({ proxyId: null }),
      });
    const deactivate = (spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/packages/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(spaceAdmin),
      });

    expect((await configure(runs.id)).status).toBe(200);
    expect((await configure(visits.id)).status).toBe(403);
    expect((await deactivate(runs.id)).status).toBe(204);
    expect((await deactivate(visits.id)).status).toBe(403);
  });

  it("answers a caller with no activation authority identically, present or absent", async () => {
    // The gate runs before the catalog lookup so a caller with no authority
    // gets the same answer whether or not the package exists (no enumeration
    // oracle).
    const asViewer = await memberContext(owner, "member");
    await seedSpaceMember({ spaceId: runs.id, userId: asViewer.user.id, presetRole: "viewer" });
    await seedSpacePackage(runs.id, AGENT);

    const missing = "@testorg/does-not-exist";
    const put = (pkg: string, ctx: TestContext) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ proxyId: null }),
      });
    const del = (pkg: string, ctx: TestContext) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

    for (const [label, existing, absent] of [
      [
        "activate",
        await activate(asViewer, runs.id, AGENT),
        await activate(asViewer, runs.id, missing),
      ],
      ["put", await put(AGENT, asViewer), await put(missing, asViewer)],
      ["delete", await del(AGENT, asViewer), await del(missing, asViewer)],
    ] as const) {
      expect(`${label}:${existing.status}`).toBe(`${label}:403`);
      expect(`${label}:${absent.status}`).toBe(`${label}:403`);
    }

    // Control: a caller who DOES hold the strings tells the two apart — so the
    // matching 403s above are the gate, not a route that answers 403 always.
    expect((await put(missing, spaceAdmin)).status).toBe(404);
    expect((await put(AGENT, spaceAdmin)).status).toBe(200);
    expect((await del(missing, spaceAdmin)).status).toBe(404);
    expect((await del(AGENT, spaceAdmin)).status).toBe(204);
    expect((await activate(spaceAdmin, runs.id, missing)).status).toBe(404);
  });

  it("an unknown package is 404 for a caller who passed the gate", async () => {
    const res = await activate(owner, runs.id, "@testorg/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("refuses an id it cannot reach in the SAME words as one that does not exist, on all three doors", async () => {
    // The oracle this closes: a caller who PASSES the gate must get ONE
    // `detail` string for both a nonexistent id and one that exists but lives
    // somewhere they cannot reach. Two strings would let id-guessing enumerate
    // the organization's packages, personal spaces included (RBAC §3.6).
    // All three doors now read the catalogue through the same reachability
    // rule the READ routes obey, so the two bodies are byte-identical.
    const stranger = await memberContext(owner, "member");
    const theirs = await seedSpace({
      orgId: owner.orgId,
      name: "Private",
      ownerUserId: stranger.user.id,
      visibility: "private",
    });
    const PRIVATE = "@testorg/somebody-elses";
    await seedPackage({ orgId: owner.orgId, id: PRIVATE, homeSpaceId: theirs.id });
    const MISSING = "@testorg/no-such-package";

    const bodyOf = async (res: Response) => {
      const body = (await res.json()) as { detail?: string; code?: string };
      return { status: res.status, code: body.code, detail: body.detail?.replace(PRIVATE, "<id>") };
    };
    const put = (pkg: string) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "PUT",
        headers: authHeaders(spaceAdmin, { "Content-Type": "application/json" }),
        body: JSON.stringify({ proxyId: null }),
      });
    const del = (pkg: string) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "DELETE",
        headers: authHeaders(spaceAdmin),
      });

    for (const [label, unreachable, absent] of [
      [
        "activate",
        await activate(spaceAdmin, runs.id, PRIVATE),
        await activate(spaceAdmin, runs.id, MISSING),
      ],
      ["put", await put(PRIVATE), await put(MISSING)],
      ["delete", await del(PRIVATE), await del(MISSING)],
    ] as const) {
      const a = await bodyOf(unreachable);
      const b = await bodyOf(absent);
      expect({ label, ...a }).toEqual({
        label,
        ...b,
        detail: b.detail?.replace(MISSING, "<id>"),
      });
      expect(a.status).toBe(404);
    }
  });
});
