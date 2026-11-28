// SPDX-License-Identifier: Apache-2.0

/**
 * `personal_space_role` over HTTP (RBAC spec §3.6): `operator` first, then the other
 * presets and a custom role of the org as the default.
 *
 * The cap holds an org MEMBER in their own personal space to `operator` plus the
 * four delete permissions. The claims, in order: what it refuses (compose, author,
 * publish, rename), what it leaves (run, activate, connect, delete what is already
 * there), who it does not touch (owner, admin), how a guest takes it, and that it is computed —
 * flipping the setting restores `admin` on the next request with no other write.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { runs, schedules } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { expectProblem } from "../../helpers/assertions.ts";
import {
  createTestContext,
  memberContext,
  orgOnlyHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import {
  seedAgent,
  seedPackage,
  seedOrgOffer,
  seedPublishedVersion,
  seedSchedule,
  seedSpace,
  seedSpaceMember,
  seedSpacePackage,
  seedSpaceRole,
} from "../../helpers/seed.ts";
import {
  createFakeOrchestrator,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { DELETES, personalOf } from "../../helpers/personal-space.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

import { triggerScheduledRun } from "../../../src/services/scheduler.ts";

const app = getTestApp();

const headersFor = (ctx: TestContext, spaceId: string) => ({
  Cookie: ctx.cookie,
  "X-Org-Id": ctx.orgId,
  "X-Space-Id": spaceId,
});

const json = { "Content-Type": "application/json" };

async function setCap(owner: TestContext, value: string | null): Promise<void> {
  const res = await app.request(`/api/orgs/${owner.orgId}/settings`, {
    method: "PATCH",
    headers: { Cookie: owner.cookie, ...json },
    // `null` means "never set": the key is simply not sent, the test starts without it.
    body: JSON.stringify(
      value === null
        ? {}
        : {
            personal_space_role: value.startsWith("srl_")
              ? { custom_role_id: value }
              : { preset_role: value },
          },
    ),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

function validateInline(ctx: TestContext, spaceId: string) {
  return app.request("/api/runs/inline/validate", {
    method: "POST",
    headers: { ...headersFor(ctx, spaceId), ...json },
    body: JSON.stringify({}),
  });
}

/** The status each authoring door answers for the caller, an empty body past the guard being a 4xx. */
async function authoringStatuses(ctx: TestContext, spaceId: string, agentId: string) {
  const call = async (method: string, path: string) =>
    (
      await app.request(path, {
        method,
        headers: { ...headersFor(ctx, spaceId), ...json },
        body: JSON.stringify({}),
      })
    ).status;
  return {
    createAgent: await call("POST", "/api/packages/agents"),
    saveDraft: await call("PATCH", `/api/packages/agents/${agentId}`),
    publish: await call("POST", `/api/packages/agents/${agentId}/versions`),
    createSkill: await call("POST", "/api/packages/skills"),
  };
}

describe("personal_space_role: operator", () => {
  let owner: TestContext;
  let admin: TestContext;
  let member: TestContext;
  let guest: TestContext;
  let personalId: string;
  let builderSpaceId: string;
  let operatorSpaceId: string;
  let agentId: string;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    owner = await createTestContext({ orgSlug: "capped" });
    // The launch case below reaches a 201, which needs a model on the org.
    await seedDefaultOrgModel(owner);
    admin = await memberContext(owner, "admin");
    member = await memberContext(owner, "member");
    guest = await memberContext(owner, "guest");
    personalId = (await personalOf(member)).id;

    const builderSpace = await seedSpace({
      orgId: owner.orgId,
      name: "Builders",
      visibility: "closed",
    });
    builderSpaceId = builderSpace.id;
    await seedSpaceMember({
      spaceId: builderSpaceId,
      userId: member.user.id,
      presetRole: "builder",
    });
    const operatorSpace = await seedSpace({
      orgId: owner.orgId,
      name: "Operators",
      visibility: "closed",
    });
    operatorSpaceId = operatorSpace.id;
    await seedSpaceMember({
      spaceId: operatorSpaceId,
      userId: member.user.id,
      presetRole: "operator",
    });

    // An agent the member already owns in their personal space, active there.
    agentId = `@${owner.org.slug}/own-agent`;
    await seedPackage({
      id: agentId,
      orgId: owner.orgId,
      type: "agent",
      homeSpaceId: personalId,
    });
    await seedSpacePackage(personalId, agentId);
  });

  it("continues firing a personal draft schedule authorized before the cap", async () => {
    const response = await app.request(`/api/agents/${agentId}/schedules`, {
      method: "POST",
      headers: { ...headersFor(member, personalId), ...json },
      body: JSON.stringify({ cron_expression: "0 9 * * *", version_override: "draft" }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = (await response.json()) as { id: string };
    await setCap(owner, "operator");

    await triggerScheduledRun(id);
    await waitForRunPipelineSettled();
    const fired = await db.select().from(runs).where(eq(runs.scheduleId, id));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      packageId: agentId,
      spaceId: personalId,
      versionRef: "draft",
    });
    // A preflight refusal also creates a run row, but it never resolves a model.
    expect(fired[0]!.modelId).toBeTruthy();
  });

  describe("under the cap", () => {
    beforeEach(async () => {
      await setCap(owner, "operator");
    });

    it("refuses an inline run with an actionable 403 naming the spaces that allow it", async () => {
      for (const path of ["/api/runs/inline", "/api/runs/inline/validate"]) {
        const res = await app.request(path, {
          method: "POST",
          headers: { ...headersFor(member, personalId), ...json },
          body: JSON.stringify({}),
        });
        const body = await expectProblem(res, 403, { code: "inline_run_not_allowed_in_space" });
        const named = (body as unknown as { active_in_spaces: { id: string }[] }).active_in_spaces;
        const ids = named.map((s) => s.id);
        expect(ids, path).toContain(builderSpaceId);
        expect(ids, path).not.toContain(operatorSpaceId);
        expect(ids, path).not.toContain(personalId);
      }
    });

    it("refuses creating, saving, publishing and a skill", async () => {
      const statuses = await authoringStatuses(member, personalId, agentId);
      expect(statuses).toEqual({
        createAgent: 403,
        saveDraft: 403,
        publish: 403,
        createSkill: 403,
      });
    });

    // A capped member runs what is PUBLISHED and ACTIVE in their space; a draft is authoring,
    // which the cap removes (`agents:write`). The rule is kept, and these two cases pin it.
    it("launches a published agent active in the personal space (201: every guard and the version stage passed)", async () => {
      const published = `@${owner.org.slug}/published-agent`;
      await seedAgent({
        id: published,
        homeSpaceId: personalId,
        orgId: owner.orgId,
        createdBy: member.user.id,
        draftManifest: { name: published, version: "0.1.0", type: "agent" },
        draftContent: "Published prompt.",
      });
      await seedPublishedVersion(published, "0.1.0");
      await seedSpacePackage(personalId, published);

      const res = await app.request(`/api/agents/${published}/run`, {
        method: "POST",
        headers: { ...headersFor(member, personalId), ...json },
        body: JSON.stringify({ input: {} }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      await waitForRunPipelineSettled();
    });

    it("refuses a never-published agent: 404 no_published_version, 403 draft_not_writable for the draft, deletable", async () => {
      const launch = (query: string) =>
        app.request(`/api/agents/${agentId}/run${query}`, {
          method: "POST",
          headers: { ...headersFor(member, personalId), ...json },
          body: JSON.stringify({ input: {} }),
        });
      await expectProblem(await launch(""), 404, { code: "no_published_version" });
      await expectProblem(await launch("?version=draft"), 403, { code: "draft_not_writable" });

      const removed = await app.request(`/api/packages/agents/${agentId}`, {
        method: "DELETE",
        headers: headersFor(member, personalId),
      });
      expect(removed.status, await removed.clone().text()).toBe(204);
    });

    it("can launch a shared draft when the member can edit it in its team home", async () => {
      const shared = `@${owner.org.slug}/team-draft`;
      await seedAgent({ id: shared, orgId: owner.orgId, homeSpaceId: builderSpaceId });
      await seedSpacePackage(personalId, shared);
      const response = await app.request(`/api/agents/${shared}/run?version=draft`, {
        method: "POST",
        headers: { ...headersFor(member, personalId), ...json },
        body: JSON.stringify({ input: {} }),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        packageId: shared,
        spaceId: personalId,
        version_ref: "draft",
      });
      await waitForRunPipelineSettled();
    });

    it("still activates and deactivates a package in the member's own space", async () => {
      const offered = `@${owner.org.slug}/team-agent`;
      await seedPackage({
        id: offered,
        orgId: owner.orgId,
        type: "agent",
        homeSpaceId: owner.defaultSpaceId,
      });
      await seedOrgOffer(owner.orgId, offered, "available");

      const activated = await app.request(`/api/spaces/${personalId}/packages`, {
        method: "POST",
        headers: { ...orgOnlyHeaders(member), ...json },
        body: JSON.stringify({ packageId: offered }),
      });
      expect([200, 201], await activated.clone().text()).toContain(activated.status);

      const deactivated = await app.request(`/api/spaces/${personalId}/packages/${offered}`, {
        method: "DELETE",
        headers: orgOnlyHeaders(member),
      });
      expect(deactivated.status, await deactivated.clone().text()).toBe(204);
    });

    it("still reads the integration catalog to connect", async () => {
      const res = await app.request("/api/integrations", {
        headers: headersFor(member, personalId),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it("still deletes a schedule and an agent already there", async () => {
      const schedule = await seedSchedule({
        packageId: agentId,
        orgId: owner.orgId,
        spaceId: personalId,
        userId: member.user.id,
      });
      const removedSchedule = await app.request(`/api/schedules/${schedule.id}`, {
        method: "DELETE",
        headers: headersFor(member, personalId),
      });
      expect(removedSchedule.status, await removedSchedule.clone().text()).toBe(204);
      expect(await db.select().from(schedules).where(eq(schedules.id, schedule.id))).toEqual([]);

      const removedAgent = await app.request(`/api/packages/agents/${agentId}`, {
        method: "DELETE",
        headers: headersFor(member, personalId),
      });
      expect(removedAgent.status, await removedAgent.clone().text()).toBe(204);
    });

    it("refuses renaming the space", async () => {
      const res = await app.request(`/api/spaces/${personalId}`, {
        method: "PATCH",
        headers: { ...orgOnlyHeaders(member), ...json },
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status, await res.clone().text()).toBe(403);
    });

    it("reports role operator and the capped permissions on GET /api/spaces", async () => {
      const own = await personalOf(member);
      expect(own.role).toMatchObject({ preset_role: "operator" });
      for (const permission of DELETES) expect(own.permissions).toContain(permission);
      for (const permission of ["agents:write", "agents:configure", "skills:write"]) {
        expect(own.permissions).not.toContain(permission);
      }
      expect(own.permissions).toContain("agents:run");
    });

    it("leaves an org admin's own personal space at admin", async () => {
      const own = await personalOf(admin);
      expect(own.role).toMatchObject({ preset_role: "admin" });
      expect(own.permissions).toContain("agents:write");
      const res = await validateInline(admin, own.id);
      expect(res.status, await res.clone().text()).not.toBe(403);
    });

    it("gives a guest the operator default too, deletes included", async () => {
      const own = await personalOf(guest);
      expect(own.role).toMatchObject({ preset_role: "operator" });
      for (const permission of DELETES) expect(own.permissions).toContain(permission);
      await expectProblem(await validateInline(guest, own.id), 403, {
        code: "inline_run_not_allowed_in_space",
      });
    });

    it("restores admin on the next request once the setting is flipped back", async () => {
      await expectProblem(await validateInline(member, personalId), 403, {
        code: "inline_run_not_allowed_in_space",
      });
      await setCap(owner, "admin");
      const res = await validateInline(member, personalId);
      expect(res.status, await res.clone().text()).not.toBe(403);
      expect((await personalOf(member)).role).toMatchObject({ preset_role: "admin" });
    });
  });

  describe("without the setting", () => {
    beforeEach(async () => {
      await setCap(owner, null);
    });

    it("holds admin in the personal space, as before", async () => {
      const own = await personalOf(member);
      expect(own.role).toMatchObject({ preset_role: "admin" });
      const res = await validateInline(member, personalId);
      expect(res.status, await res.clone().text()).not.toBe(403);
      const statuses = await authoringStatuses(member, personalId, agentId);
      for (const [door, status] of Object.entries(statuses)) {
        expect(status, door).not.toBe(403);
      }
    });

    it("answers a guest's inline run with the actionable refusal, the cap being irrelevant", async () => {
      const own = await personalOf(guest);
      await expectProblem(await validateInline(guest, own.id), 403, {
        code: "inline_run_not_allowed_in_space",
      });
    });
  });

  describe("another preset or a custom role as the default", () => {
    it("gives a member builder or viewer plus the delete floor", async () => {
      await setCap(owner, "builder");
      const asBuilder = await personalOf(member);
      expect(asBuilder.role).toMatchObject({ preset_role: "builder" });
      expect(asBuilder.permissions).toContain("agents:write");
      for (const permission of DELETES) expect(asBuilder.permissions).toContain(permission);

      await setCap(owner, "viewer");
      const asViewer = await personalOf(member);
      expect(asViewer.role).toMatchObject({ preset_role: "viewer" });
      for (const permission of DELETES) expect(asViewer.permissions).toContain(permission);
      for (const permission of ["agents:write", "agents:run"]) {
        expect(asViewer.permissions).not.toContain(permission);
      }
      const statuses = await authoringStatuses(member, personalId, agentId);
      expect(statuses.createAgent).toBe(403);
    });

    it("caps a guest to operator plus the floor under an authoring default, and gives them a narrower one", async () => {
      await setCap(owner, "builder");
      const asBuilder = await personalOf(guest);
      expect(asBuilder.role).toMatchObject({ preset_role: "operator" });
      expect(asBuilder.permissions).not.toContain("agents:write");
      for (const permission of DELETES) expect(asBuilder.permissions).toContain(permission);

      // A custom default granting `agents:write` caps a guest the same way.
      const author = await seedSpaceRole({
        orgId: owner.orgId,
        key: "author",
        name: "Author",
        permissions: ["agents:read", "agents:write"],
      });
      await setCap(owner, author.id);
      const asAuthor = await personalOf(guest);
      // Restricted to what `operator` grants: the chosen role, named as such, without its write half.
      expect(asAuthor.role).toMatchObject({ custom_role_id: author.id, name: "Author" });
      expect(asAuthor.permissions).toContain("agents:read");
      expect(asAuthor.permissions).not.toContain("agents:write");
      for (const permission of DELETES) expect(asAuthor.permissions).toContain(permission);
      expect((await personalOf(member)).role).toMatchObject({
        custom_role_id: author.id,
        name: "Author",
      });

      // A guest never outranks a member: under `viewer` both hold viewer plus the floor.
      await setCap(owner, "viewer");
      const asViewer = await personalOf(guest);
      expect(asViewer.role).toMatchObject({ preset_role: "viewer" });
      expect(asViewer.permissions).not.toContain("agents:run");
      for (const permission of DELETES) expect(asViewer.permissions).toContain(permission);
    });

    describe("a custom role as the default", () => {
      let role: Awaited<ReturnType<typeof seedSpaceRole>>;
      beforeEach(async () => {
        // `shows_studio: false`: the Studio is what this role withholds.
        role = await seedSpaceRole({
          orgId: owner.orgId,
          key: "runner-lite",
          name: "Runner lite",
          permissions: ["agents:read", "agents:run", "runs:read"],
          showsStudio: false,
        });
        await setCap(owner, role.id);
      });

      it("gives a member its permissions plus the floor on GET /api/spaces", async () => {
        const own = await personalOf(member);
        expect(own.role).toMatchObject({ custom_role_id: role.id, name: "Runner lite" });
        expect(own.shows_studio).toBe(false);
        expect(own.permissions).not.toContain("agents:write");
        for (const permission of ["agents:read", "agents:run", "runs:read", ...DELETES]) {
          expect(own.permissions).toContain(permission);
        }
      });

      it("names it on the space detail", async () => {
        const detail = await app.request(`/api/spaces/${personalId}`, {
          headers: orgOnlyHeaders(member),
        });
        expect(detail.status, await detail.clone().text()).toBe(200);
        expect(await detail.json()).toMatchObject({
          role: { custom_role_id: role.id, name: "Runner lite" },
        });
      });

      it("leaves an org admin at admin", async () => {
        expect((await personalOf(admin)).role).toMatchObject({ preset_role: "admin" });
      });

      it("gives a guest the same role, never above a member", async () => {
        const guestOwn = await personalOf(guest);
        expect(guestOwn.role).toMatchObject({ custom_role_id: role.id, name: "Runner lite" });
        expect(guestOwn.permissions).not.toContain("agents:write");
        for (const permission of DELETES) expect(guestOwn.permissions).toContain(permission);
      });
    });
  });
});
