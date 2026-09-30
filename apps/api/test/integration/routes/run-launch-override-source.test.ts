// SPDX-License-Identifier: Apache-2.0

/**
 * The launch-override layer is ONE cascade layer fed by whichever launched the
 * run, and the bound set records which: a run's `connection_overrides` bind as
 * `run_override`, a schedule fire's as `schedule_override`. Read off
 * `runs.resolved_connections`, the audit trail the credentials route and the
 * run's connections panel trust. An override naming what governance outranks or
 * the caller cannot reach is refused before any run row exists.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { integrationPins, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  memberContext,
  type TestContext,
} from "../../helpers/auth.ts";
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
  let other: string;

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
    other = await seedIntegrationConnection(ctx, INTEGRATION);
  });

  function launch(ids: string[]) {
    return app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ connection_overrides: { [INTEGRATION]: ids } }),
    });
  }

  /** The one refusal item of a `409 missing_integration_connection`, the response text beside it. */
  async function refusal(res: Response): Promise<{ code: string; text: string }> {
    expect(res.status).toBe(409);
    const text = await res.text();
    const body = JSON.parse(text) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe("missing_integration_connection");
    expect(body.errors.map((e) => e.field)).toEqual([`integrations.${INTEGRATION}`]);
    return { code: body.errors[0]!.code, text };
  }

  it("a run's connection_overrides bind as run_override, and are kept on the row", async () => {
    const res = await launch([picked]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [{ connectionId: picked, source: "run_override" }],
    });
    expect(row!.connectionOverrides).toEqual({ [INTEGRATION]: [picked] });
    await waitForRunPipelineSettled();
  });

  it("binds every connection the override names, in its order", async () => {
    const res = await launch([other, picked]);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    expect(row!.resolvedConnections).toMatchObject({
      [INTEGRATION]: [
        { connectionId: other, source: "run_override" },
        { connectionId: picked, source: "run_override" },
      ],
    });
    await waitForRunPipelineSettled();
  });

  it("refuses an override outside the admin pin (override_outranked) and creates no run", async () => {
    await db.insert(integrationPins).values({
      spaceId: ctx.defaultSpaceId,
      packageId: AGENT,
      integrationId: INTEGRATION,
      userId: null,
      connectionIds: [picked],
    });

    expect((await refusal(await launch([other]))).code).toBe("override_outranked");
    expect(await db.select().from(runs)).toHaveLength(0);
    // Control: an override inside the pin narrows it and launches.
    expect((await launch([picked])).status).toBe(201);
    await waitForRunPipelineSettled();
  });

  it("refuses a colleague's private connection like an unknown id, naming neither label nor account", async () => {
    const colleague = await memberContext(ctx, "member");
    const theirs = await seedIntegrationConnection(colleague, INTEGRATION, {
      label: "colleague-label",
      accountId: "colleague-account",
    });

    const { code, text } = await refusal(await launch([theirs]));
    expect(code).toBe("override_connection_unavailable");
    expect(text).not.toContain("colleague-label");
    expect(text).not.toContain("colleague-account");
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("refuses a connection_overrides key the agent does not declare (400) and creates no run", async () => {
    // Before, the resolver read only declared ids, so a typo was dropped and a
    // lower layer bound instead of the account the caller asked for.
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_overrides: { [INTEGRATION]: [picked], "@launchorg/typo": [other] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; param?: string; detail: string };
    expect(body.code).toBe("invalid_request");
    expect(body.param).toBe("connection_overrides");
    expect(body.detail).toContain("@launchorg/typo");
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it("refuses an undeclared connection_overrides key on the inline launch and its validator", async () => {
    const inline = {
      manifest: {
        name: "@inline/override-keys",
        display_name: "Inline",
        version: "0.0.0",
        type: "agent",
        schema_version: "0.2",
        dependencies: { integrations: { [INTEGRATION]: "^1.0.0" } },
        integrations_configuration: { [INTEGRATION]: { tools: ["search"] } },
      },
      prompt: "Search for something.",
      connection_overrides: { "@launchorg/typo": [picked] },
    };
    const request = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(inline),
      });

    const launched = await request("/api/runs/inline");
    expect(launched.status).toBe(400);
    expect(((await launched.json()) as { code: string }).code).toBe("invalid_request");
    expect(await db.select().from(runs)).toHaveLength(0);

    const validated = await request("/api/runs/inline/validate");
    expect(validated.status).toBe(400);
    const body = (await validated.json()) as {
      code: string;
      errors: { field: string; message: string }[];
    };
    expect(body.code).toBe("validation_failed");
    const item = body.errors.find((e) => e.field === "connection_overrides");
    expect(item?.message).toContain("@launchorg/typo");
  });

  it("a schedule fire's frozen picks bind as schedule_override", async () => {
    const schedule = await seedSchedule({
      packageId: AGENT,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      connectionOverrides: { [INTEGRATION]: [picked] },
      versionOverride: "draft",
    });

    await triggerScheduledRun(schedule.id);

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
