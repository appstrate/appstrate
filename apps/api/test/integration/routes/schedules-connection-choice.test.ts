// SPDX-License-Identifier: Apache-2.0

/**
 * An armed schedule must fire without asking which connection to use: a write
 * that leaves a `must_choose_connection` open for the schedule's actor is a
 * `409 missing_integration_connection` carrying only those items. Every other
 * connection verdict is accepted — it is repaired without editing the schedule.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { schedules } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedSchedule } from "../../helpers/seed.ts";
import { seedDivergedAgent, seedSchedulableAgent } from "../../helpers/schedule-fixtures.ts";
import {
  seedConnectionTestIntegration,
  seedIntegrationConnection,
} from "../../helpers/run-connection-fixtures.ts";

const app = getTestApp();

const AGENT = "@schedchoice/agent";
const INTEGRATION = "@schedchoice/svc";

function agentManifest(integrations: boolean): Record<string, unknown> {
  return {
    name: AGENT,
    version: "1.0.0",
    type: "agent",
    schema_version: "0.2",
    display_name: "Schedule Choice Agent",
    ...(integrations
      ? {
          dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
          integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
        }
      : {}),
  };
}

interface ProblemBody {
  code: string;
  errors: { field: string; code: string; candidate_connections?: { id: string }[] }[];
}

describe("schedule writes — the connection choice is made up front", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedchoice" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
  });

  async function seedAgentWithIntegration(): Promise<void> {
    await seedSchedulableAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      manifest: agentManifest(true),
    });
  }

  function create(body: Record<string, unknown>) {
    return app.request(`/api/agents/${AGENT}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", ...body }),
    });
  }

  function patch(id: string, body: Record<string, unknown>) {
    return app.request(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function seedArmedSchedule(connectionOverrides: Record<string, string[]> | null = null) {
    return seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: true,
      connectionOverrides,
    });
  }

  it("refuses a create whose actor holds two connections and names none", async () => {
    await seedAgentWithIntegration();
    const a = await seedIntegrationConnection(ctx, INTEGRATION);
    const b = await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({});
    expect(res.status).toBe(409);
    const body = (await res.json()) as ProblemBody;
    expect(body.code).toBe("missing_integration_connection");
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.field).toBe(`integrations.${INTEGRATION}`);
    expect(body.errors[0]!.code).toBe("must_choose_connection");
    expect(body.errors[0]!.candidate_connections!.map((c) => c.id).sort()).toEqual([a, b].sort());
    expect(await db.select().from(schedules)).toHaveLength(0);
  });

  it("accepts the same create once connection_overrides names one", async () => {
    await seedAgentWithIntegration();
    const picked = await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);

    const res = await create({ connection_overrides: { [INTEGRATION]: [picked] } });
    expect(res.status).toBe(201);
  });

  it("accepts a create whose integration is not connected at all", async () => {
    // Connecting later fixes it without editing the schedule.
    await seedAgentWithIntegration();

    const res = await create({});
    expect(res.status).toBe(201);
  });

  it("does not judge a patch that disables the schedule", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedArmedSchedule();

    const res = await patch(schedule.id, { enabled: false });
    expect(res.status).toBe(200);
  });

  it("refuses re-enabling a disabled schedule that leaves the choice open", async () => {
    await seedAgentWithIntegration();
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      enabled: false,
    });

    const res = await patch(schedule.id, { enabled: true });
    expect(res.status).toBe(409);
  });

  it("refuses any patch of an armed schedule whose resolution became ambiguous", async () => {
    await seedAgentWithIntegration();
    const first = await seedIntegrationConnection(ctx, INTEGRATION);
    const created = await create({});
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // A second connection since the last save: the fallback no longer decides.
    await seedIntegrationConnection(ctx, INTEGRATION);

    const refused = await patch(id, { name: "renamed" });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as ProblemBody;
    expect(body.errors.map((e) => e.code)).toEqual(["must_choose_connection"]);

    const repaired = await patch(id, {
      name: "renamed",
      connection_overrides: { [INTEGRATION]: [first] },
    });
    expect(repaired.status).toBe(200);
  });

  it("judges the definition the schedule fires, not the draft", async () => {
    // Published declares no integration; the draft does.
    await seedDivergedAgent({
      id: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      published: agentManifest(false),
      draft: agentManifest(true),
    });
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);

    expect((await create({})).status).toBe(201);
    expect((await create({ version_override: "draft" })).status).toBe(409);

    // A patch moving an armed schedule onto the draft is judged against it too.
    const inherit = (await db.select().from(schedules))[0]!;
    expect((await patch(inherit.id, { version_override: "draft" })).status).toBe(409);
    await db.update(schedules).set({ enabled: false }).where(eq(schedules.id, inherit.id));
    expect((await patch(inherit.id, { version_override: "draft" })).status).toBe(200);
  });
});
