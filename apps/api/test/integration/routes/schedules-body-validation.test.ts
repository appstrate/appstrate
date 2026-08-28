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
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedSchedule } from "../../helpers/seed.ts";
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
    await seedSchedulableAgent({
      id: agentRef,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
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

  it('accepts "draft" and a semver spec as dependency_overrides values (control)', async () => {
    const res = await post({
      cron_expression: "0 9 * * 1-5",
      dependency_overrides: { "@acme/skill": "draft", "@acme/other": "^1.2.0" },
    });
    expect(res.status).toBe(201);
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
