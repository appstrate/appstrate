// SPDX-License-Identifier: Apache-2.0

/**
 * The launch-override layer is ONE cascade layer fed by whichever launched the
 * run, and the bound set records which: a run's `connection_overrides` bind as
 * `run_override`, a schedule fire's as `schedule_override`. Read off
 * `runs.resolved_connections`, the audit trail the credentials route and the
 * run's connections panel trust.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSchedule } from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  createFakeOrchestrator,
  seedConnectionTestIntegration,
  seedDefaultOrgModel,
  seedIntegrationConnection,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";

const app = getTestApp();

const AGENT = "@launchorg/agent";
const INTEGRATION = "@launchorg/svc";

describe("launch override — the bound set names the launch it came from", () => {
  let ctx: TestContext;
  let picked: string;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "launchorg" });
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT,
        version: "1.0.0",
        type: "agent",
        schema_version: "0.2",
        display_name: "Launch Override Agent",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
      draftContent: "Search for something.",
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    // Two own connections: without a pick the fallback refuses (must_choose),
    // so a run that starts proves the override was the layer that bound.
    picked = await seedIntegrationConnection(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
  });

  it("a run's connection_overrides bind as run_override, and are kept on the row", async () => {
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_overrides: { [INTEGRATION]: [picked] } }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "run_override" }],
    });
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [picked] });
    await waitForRunPipelineSettled();
  });

  it("a schedule fire's frozen picks bind as schedule_override", async () => {
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      connectionOverrides: { [INTEGRATION]: [picked] },
    });

    await triggerScheduledRun(
      schedule.id,
      AGENT,
      { type: "user", id: ctx.user.id },
      ctx.orgId,
      ctx.defaultSpaceId,
      undefined,
      { versionOverride: "draft", connectionOverrides: { [INTEGRATION]: [picked] } },
    );

    const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    expect(row!.status).not.toBe("failed");
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "schedule_override" }],
    });
    // The pick lives on the schedule row; the run keeps only the caller's own overrides.
    expect(row!.connectionOverrides).toBeNull();
    await waitForRunPipelineSettled();
  });
});
