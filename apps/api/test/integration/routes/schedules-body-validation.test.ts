// SPDX-License-Identifier: Apache-2.0

/**
 * Launch-body validation on the SCHEDULE surface — the fourth agent-launch
 * surface, and the one #1187/#1189 missed while covering the other three
 * (`POST /agents/:scope/:name/run`, `POST /runs/inline`, `POST /runs/remote`;
 * see `runs-body-validation.test.ts`).
 *
 * A schedule is the surface where a body defect costs the most. The other three
 * mis-execute a single run and the caller sees it; a schedule FREEZES the body
 * onto `package_schedules` and replays it on every tick, so a value the write
 * accepted but the fire path cannot honour is a wrong run forever, with a `201`
 * as the only receipt. The three cases below are exactly the three the schema
 * did not gate:
 *
 *  - an empty-string `connection_overrides` value — falsy at the resolver's
 *    `resolveOne`, so the pin is skipped in silence and each fire falls through
 *    to actor-fallback or dies with a 412 `must_choose_connection`;
 *  - an unknown field — stripped without a trace where the other launch bodies
 *    are `.strict()`;
 *  - a `dependency_overrides` value the resolver rejects (`"latest"`) — the
 *    schedule path resolves input through `resolveEffectiveInput` +
 *    `validateInput` and never calls `parseRequestInput`, so
 *    `isValidDependencyOverride` had no owner here and the value died at every
 *    fire instead of at the write.
 *
 * Every negative case is paired with the control that the same body MINUS the
 * defect is accepted, so a `400` here can only mean the field was refused —
 * never that the request failed for an unrelated reason.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { schedules } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  addOrgMember,
  authHeaders,
  createTestContext,
  createTestUser,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedPackage, seedSchedule, seedSpace, seedSpaceMember } from "../../helpers/seed.ts";

/** A skill the fixture agent DECLARES and this caller writes (homed in their space). */
const DECLARED_SKILL = "@schedbodyorg/dep-skill";
/** A second declared skill, for the value cases that need a non-`draft` spec. */
const DECLARED_OTHER = "@schedbodyorg/dep-other";
import { expectRejectedField } from "../../helpers/body-validation.ts";
import { seedSchedulableAgent } from "../../helpers/schedule-fixtures.ts";

const app = getTestApp();

describe("POST /api/agents/:scope/:name/schedules — body validation", () => {
  let ctx: TestContext;
  let agentRef: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedbodyorg" });
    agentRef = "@schedbodyorg/sched-body-agent";
    // Published, not merely drafted: both write routes validate against the
    // manifest the schedule will FIRE, and with no `version_override` that is
    // the published version — a draft-only agent 404s before any body rule is
    // reached, which would make every control below vacuous.
    // The two dependencies the `dependency_overrides` cases key on. A key that
    // names nothing the effective manifest declares is refused on its own rule
    // (400, before the authority gate), so a control that wants to exercise the
    // VALUE gate has to name declared ones.
    await seedPackage({
      id: DECLARED_SKILL,
      type: "skill",
      orgId: ctx.orgId,
      homeSpaceId: ctx.defaultSpaceId,
      createdBy: ctx.user.id,
      draftManifest: { name: DECLARED_SKILL, version: "1.0.0", type: "skill" },
    });
    await seedSchedulableAgent({
      id: agentRef,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: {
        name: agentRef,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Sched Body Agent",
        author: "tester",
        dependencies: { skills: { [DECLARED_SKILL]: "^1.0.0", [DECLARED_OTHER]: "^1.0.0" } },
      },
    });
  });

  async function post(body: Record<string, unknown>) {
    return app.request(`/api/agents/${agentRef}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("accepts a minimal legal body (control)", async () => {
    const res = await post({ cron_expression: "0 9 * * 1-5" });
    expect(res.status).toBe(201);
  });

  it("rejects an unknown field with 400 instead of freezing a schedule without it", async () => {
    const res = await post({ cron_expression: "0 9 * * 1-5", config: { days: 30 } });
    await expectRejectedField(res, "config");
  });

  it("rejects an empty connection_overrides value with 400", async () => {
    // Empty string is falsy at `resolveOne`, so the frozen pin would be skipped
    // on every fire while this write answered 201.
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      connection_overrides: { "@acme/gmail": "" },
    });
    await expectRejectedField(res, "connection_overrides.@acme/gmail");
  });

  it("accepts a non-empty connection_overrides value (control)", async () => {
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      connection_overrides: { "@acme/gmail": "conn_1" },
    });
    expect(res.status).toBe(201);
  });

  it('rejects a "latest" dependency_overrides value with 400', async () => {
    // `isValidDependencyOverride` refuses the protected tags (`latest`,
    // `published`): they can never exist as real dist-tags, so the value could
    // only ever fail — previously at every fire, now at the write.
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      dependency_overrides: { "@acme/skill": "latest" },
    });
    await expectRejectedField(res, "dependency_overrides");
  });

  it("rejects a dependency_overrides KEY the manifest does not declare, before the authority gate", async () => {
    // Form before authority: an override on a dependency the agent does not
    // declare has no effect downstream, so it is a malformed request rather
    // than an unauthorized one — and `draft` is spelled here deliberately, to
    // pin that the 400 wins over the 403 the value would otherwise attract.
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      dependency_overrides: { "@schedbodyorg/undeclared": "draft" },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { code?: string; detail?: string };
    expect(problem.code).toBe("invalid_request");
    expect(problem.detail).toContain("@schedbodyorg/undeclared");
  });

  it('accepts "draft" and a semver spec as dependency_overrides values (control)', async () => {
    // Both keys are DECLARED, so the key gate is satisfied and the case is
    // about the VALUE gate alone. `draft` is keyed on the skill this caller
    // demonstrably writes (homed in their own space): a `draft` entry also
    // proves WRITE authority over the package it names, so keying it on an id
    // nobody owns would answer 403 on that rule instead.
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      dependency_overrides: { [DECLARED_SKILL]: "draft", [DECLARED_OTHER]: "^1.2.0" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe("PUT /api/schedules/:id — body validation", () => {
  let ctx: TestContext;
  let scheduleId: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedputorg" });
    const agentRef = "@schedputorg/sched-put-agent";
    await seedSchedulableAgent({
      id: agentRef,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
    });
    const schedule = await seedSchedule({
      packageId: agentRef,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      cronExpression: "0 * * * *",
      name: "Hourly",
    });
    scheduleId = schedule.id;
  });

  async function put(body: Record<string, unknown>) {
    return app.request(`/api/schedules/${scheduleId}`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("accepts a legal patch (control)", async () => {
    const res = await put({ enabled: false });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown field with 400 instead of applying the rest of the patch", async () => {
    const res = await put({ enabled: false, config: { days: 30 } });
    await expectRejectedField(res, "config");
  });

  it("rejects an empty connection_overrides value with 400", async () => {
    const res = await put({ connection_overrides: { "@acme/gmail": "" } });
    await expectRejectedField(res, "connection_overrides.@acme/gmail");
  });

  it('rejects a "latest" dependency_overrides value with 400', async () => {
    const res = await put({ dependency_overrides: { "@acme/skill": "latest" } });
    await expectRejectedField(res, "dependency_overrides");
  });

  it("accepts null overrides — the documented way to clear them (control)", async () => {
    // `.nullable()` sits OUTSIDE the value gate and the refinement, so clearing
    // must stay legal on both maps.
    const res = await put({ connection_overrides: null, dependency_overrides: null });
    expect(res.status).toBe(200);
  });
});

/**
 * `dependency_overrides: { "@scope/skill": "draft" }` on the schedule writes —
 * the AUTHORITY half, not the form half.
 *
 * The two describes above cover the FORM gate
 * (`assertDependencyOverrideKeysDeclared`: a key the manifest does not declare
 * is a 400) and one POSITIVE authority case (`"draft"` keyed on a skill the
 * caller demonstrably writes → 201). Neither can tell the authority gate apart
 * from its absence: drop `assertDependencyDraftOverridesAllowed` down to the
 * key gate alone and every assertion up there still holds.
 *
 * What that drop would admit is the schedule twin of the escalation
 * `runs-version-selection.test.ts` pins for `version_override`, and it costs
 * strictly more here. A run executes a working copy ONCE, in front of the
 * caller who asked for it; a schedule FREEZES the selector onto
 * `package_schedules` and — as `routes/schedules.ts` states where it gates the
 * write — never re-judges it at fire time. So one accepted POST means every
 * tick, forever, runs the unpublished bytes of a package this principal may not
 * write, under the schedule actor's credentials.
 *
 * The discriminating principal is the one the RBAC model actually produces: a
 * `builder` of TEAM. They hold `schedules:write` there and write the AGENT too
 * (it is homed in TEAM) — which is precisely what makes every refusal below
 * attributable to the SKILL, homed in a space where they hold nothing at all.
 */
describe("schedule writes — `dependency_overrides` draft authority", () => {
  let ctx: TestContext;
  /** The SKILL's home — closed, so a role there is an explicit row and nothing else. */
  let homeId: string;
  /** Where the agent lives and where the schedules are written. */
  let teamId: string;

  const AGENT = "@schedauthorg/dep-authority-agent";
  const SKILL = "@schedauthorg/dep-authority-skill";

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedauthorg" });
    homeId = (await seedSpace({ orgId: ctx.orgId, name: "Skill Home", visibility: "closed" })).id;
    teamId = (await seedSpace({ orgId: ctx.orgId, name: "Team", visibility: "closed" })).id;

    await seedPackage({
      id: SKILL,
      type: "skill",
      orgId: ctx.orgId,
      homeSpaceId: homeId,
      createdBy: ctx.user.id,
      draftManifest: { name: SKILL, version: "1.0.0", type: "skill" },
    });
    // DECLARED by the manifest the schedule will fire, so the key gate is
    // satisfied and every case below is about the VALUE's authority alone.
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: teamId,
      userId: ctx.user.id,
      manifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.1",
        display_name: "Dep Authority Agent",
        author: "tester",
        dependencies: { skills: { [SKILL]: "^1.0.0" } },
      },
    });
  });

  /** A member holding `builder` in each of `spaceIds`, and nothing anywhere else. */
  async function builderOf(...spaceIds: string[]): Promise<Record<string, string>> {
    const user = await createTestUser();
    await addOrgMember(ctx.orgId, user.id, "member");
    for (const spaceId of spaceIds) {
      await seedSpaceMember({ spaceId, userId: user.id, presetRole: "builder" });
    }
    return { Cookie: user.cookie, "X-Org-Id": ctx.orgId, "X-Space-Id": teamId };
  }

  /** Writes the schedules AND the agent; holds nothing in the skill's home. */
  const scheduleWriter = () => builderOf(teamId);
  /** The same, plus the skill's home — so this one writes the SKILL. */
  const skillAuthor = () => builderOf(teamId, homeId);

  const postSchedule = (headers: Record<string, string>, body: Record<string, unknown>) =>
    app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * 1-5", ...body }),
    });

  const put = (headers: Record<string, string>, id: string, body: Record<string, unknown>) =>
    app.request(`/api/schedules/${id}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** A schedule armed by the skill's author — the only principal allowed to freeze `draft`. */
  async function armedSchedule(dependencyOverrides?: Record<string, string>): Promise<string> {
    const res = await postSchedule(
      await skillAuthor(),
      dependencyOverrides ? { dependency_overrides: dependencyOverrides } : {},
    );
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const storedRows = () => db.select().from(schedules).where(eq(schedules.packageId, AGENT));

  it("refuses a POST that freezes a `draft` override on a skill the caller cannot write", async () => {
    const res = await postSchedule(await scheduleWriter(), {
      dependency_overrides: { [SKILL]: "draft" },
    });
    expect(res.status, await res.clone().text()).toBe(403);
    const problem = (await res.json()) as { code?: string; detail?: string };
    expect(problem.code).toBe("draft_not_writable");
    // The refusal has to NAME the skill: the caller writes the agent, so a
    // message about "this package" would send them looking at the wrong one.
    expect(problem.detail).toContain(SKILL);
    // Nothing was armed — the refusal is the whole outcome, not a rollback.
    expect(await storedRows()).toHaveLength(0);
  });

  it("accepts the same body from a caller who writes that skill (control)", async () => {
    // The discriminating control: the body, the agent and the space are
    // identical, so the 403 above is about the principal's authority over the
    // SKILL and about nothing else in the request.
    const res = await postSchedule(await skillAuthor(), {
      dependency_overrides: { [SKILL]: "draft" },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const [row] = await storedRows();
    expect(row?.dependencyOverrides).toEqual({ [SKILL]: "draft" });
  });

  it("refuses a PUT that ADDS the `draft` override to a schedule that did not hold it", async () => {
    const id = await armedSchedule();
    const res = await put(await scheduleWriter(), id, {
      dependency_overrides: { [SKILL]: "draft" },
    });
    expect(res.status, await res.clone().text()).toBe(403);
    const problem = (await res.json()) as { code?: string; detail?: string };
    expect(problem.code).toBe("draft_not_writable");
    expect(problem.detail).toContain(SKILL);
    const [row] = await storedRows();
    expect(row?.dependencyOverrides ?? null).toBeNull();
  });

  it("accepts a PUT that echoes the stored `draft` override back unchanged", async () => {
    // Without this the refusal above would be a hole, not a gate: the edit form
    // reads the row and posts every field back, so a cron change arrives
    // carrying the override its author already proved. A stored value is not an
    // act — `movedDependencyOverrides` is what says so.
    const id = await armedSchedule({ [SKILL]: "draft" });
    const res = await put(await scheduleWriter(), id, {
      cron_expression: "0 4 * * *",
      dependency_overrides: { [SKILL]: "draft" },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await storedRows();
    expect(row?.dependencyOverrides).toEqual({ [SKILL]: "draft" });
  });

  it("accepts a PUT that DROPS the `draft` override", async () => {
    // Taking a working copy away needs no authority at all — and an operator
    // who cannot undo a draft override is an operator who has to delete the
    // schedule to stop it.
    const id = await armedSchedule({ [SKILL]: "draft" });
    const res = await put(await scheduleWriter(), id, { dependency_overrides: {} });
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await storedRows();
    expect(row?.dependencyOverrides).toEqual({});
  });
});
