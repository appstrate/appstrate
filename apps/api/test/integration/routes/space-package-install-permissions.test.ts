// SPDX-License-Identifier: Apache-2.0

/**
 * RBAC on the space-package WRITE surface — install, configure, uninstall.
 *
 * These three carried `spaces:write`, which is ORG-level: the catalog verb
 * that creates and deletes spaces, held by owner and admin only. The effect
 * was backwards in both directions — a space admin could not install into the
 * space they run, while anyone who could create a space could install into
 * every space in the org.
 *
 * The permission is now the SPACE-level string for the package type, so each
 * case below is a pair: the same caller, the same package, two spaces that
 * differ only by the role they hold there.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  createTestUser,
  addOrgMember,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedPackage,
  seedInstalledPackage,
  seedSpace,
  seedSpaceMember,
  seedSpaceRole,
} from "../../helpers/seed.ts";

const app = getTestApp();

describe("space package install/config/uninstall — permission is per package type", () => {
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
    await seedPackage({ orgId: owner.orgId, id: AGENT, type: "agent" });
    await seedPackage({ orgId: owner.orgId, id: SKILL, type: "skill" });

    const user = await createTestUser();
    await addOrgMember(owner.orgId, user.id, "member");
    await seedSpaceMember({ spaceId: runs.id, userId: user.id, presetRole: "admin" });
    spaceAdmin = { ...owner, user, cookie: user.cookie };
  });

  async function install(ctx: TestContext, spaceId: string, packageId: string): Promise<Response> {
    return app.request(`/api/spaces/${spaceId}/packages`, {
      method: "POST",
      headers: authHeaders(ctx, { "Content-Type": "application/json" }),
      body: JSON.stringify({ packageId }),
    });
  }

  it("a space admin installs an agent into their space and nowhere else", async () => {
    // `agents:configure` comes from the preset `admin` row in `runs`.
    expect((await install(spaceAdmin, runs.id, AGENT)).status).toBe(201);

    // Same caller, same agent, the space where they are only an implicit
    // `operator` — which carries `agents:read`/`agents:run` and no `configure`.
    const denied = await install(spaceAdmin, visits.id, AGENT);
    expect(denied.status).toBe(403);

    // Control: the owner installs into that same space, so the 403 is about
    // the caller's role there and not about the space or the package.
    expect((await install(owner, visits.id, AGENT)).status).toBe(201);
  });

  it("selects the resource by package type, not one string for all of them", async () => {
    // No preset separates the two — `builder` and above hold both — so the
    // discriminating caller is a custom role carrying `skills:write` and
    // nothing else. Same caller, same space, two package types, two answers.
    const skillsOnly = await seedSpaceRole({
      orgId: owner.orgId,
      key: "skills-only",
      permissions: ["skills:read", "skills:write", "agents:read"],
    });
    const author = await createTestUser();
    await addOrgMember(owner.orgId, author.id, "member");
    await seedSpaceMember({
      spaceId: visits.id,
      userId: author.id,
      presetRole: null,
      customRoleId: skillsOnly.id,
    });
    const asAuthor: TestContext = { ...owner, user: author, cookie: author.cookie };

    expect((await install(asAuthor, visits.id, SKILL)).status).toBe(201);
    expect((await install(asAuthor, visits.id, AGENT)).status).toBe(403);
  });

  it("uninstall and config read the same per-type permission", async () => {
    await seedInstalledPackage(runs.id, AGENT);
    await seedInstalledPackage(visits.id, AGENT);

    const configure = (spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/packages/${AGENT}`, {
        method: "PUT",
        headers: authHeaders(spaceAdmin, { "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true }),
      });
    const uninstall = (spaceId: string) =>
      app.request(`/api/spaces/${spaceId}/packages/${AGENT}`, {
        method: "DELETE",
        headers: authHeaders(spaceAdmin),
      });

    expect((await configure(runs.id)).status).toBe(200);
    expect((await configure(visits.id)).status).toBe(403);
    expect((await uninstall(runs.id)).status).toBe(204);
    expect((await uninstall(visits.id)).status).toBe(403);
  });

  it("answers a caller with no install authority identically, present or absent", async () => {
    // The enumeration oracle this closes: the gate used to run only when the
    // package resolved, so a caller with no authority got 403 for a package the
    // org has and 404 for one it does not — a membership probe on the catalog.
    const viewer = await createTestUser();
    await addOrgMember(owner.orgId, viewer.id, "member");
    await seedSpaceMember({ spaceId: runs.id, userId: viewer.id, presetRole: "viewer" });
    const asViewer: TestContext = { ...owner, user: viewer, cookie: viewer.cookie };
    await seedInstalledPackage(runs.id, AGENT);

    const missing = "@testorg/does-not-exist";
    const put = (pkg: string, ctx: TestContext) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "PUT",
        headers: authHeaders(ctx, { "Content-Type": "application/json" }),
        body: JSON.stringify({ enabled: true }),
      });
    const del = (pkg: string, ctx: TestContext) =>
      app.request(`/api/spaces/${runs.id}/packages/${pkg}`, {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

    for (const [label, existing, absent] of [
      [
        "install",
        await install(asViewer, runs.id, AGENT),
        await install(asViewer, runs.id, missing),
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
    expect((await install(spaceAdmin, runs.id, missing)).status).toBe(404);
  });

  it("an unknown package is 404 for a caller who passed the gate", async () => {
    const res = await install(owner, runs.id, "@testorg/does-not-exist");
    expect(res.status).toBe(404);
  });
});
