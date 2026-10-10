// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: a launched run that lost a declared integration says so in
 * `run_logs`.
 *
 * The unit half lives in
 * `services/integration-spawn-resolver-dropped.test.ts` (the resolver returns
 * `dropped[]`, and `recordDroppedIntegrations` writes the rows). This suite
 * closes the wiring the unit half cannot reach: `buildRunContext` discovers the
 * drops BEFORE `createRun`, but `run_logs.run_id` is a hard FK on `runs.id`, so
 * the marker must be carried across the create boundary and written after it.
 * Getting that order wrong writes nothing — and because the marker write is
 * best-effort by design (a failed log must never fail a ready run), the
 * breakage would be invisible without this test.
 *
 * The gap used here is a referenced mcp-server package that does not exist:
 * the connection cascade resolves fine (a connection exists, so no 409) and the
 * run launches, yet the spawn resolver cannot produce a spec — precisely the
 * "run starts without the tools it declared" case the marker exists for.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { runLogs, runs } from "@appstrate/db/schema";
import {
  createFakeOrchestrator,
  inlineAgentManifest as inlineManifest,
  seedConnectionTestIntegration,
  seedIntegrationConnection,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { seedMcpServer } from "../../helpers/seed.ts";
import { INTEGRATION_DROPPED_EVENT } from "../../../src/services/run-context-builder.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { deactivatePackage } from "../../../src/services/space-packages.ts";

const app = getTestApp();

const INTEGRATION = "@dropmark/svc";

describe("run launch — dropped-integration marker in run_logs", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "dropmark" });
  });

  // The trigger is fire-and-forget; drain here (not at the tail of a body) so a
  // failing assertion cannot leave background writes racing the next truncate.
  afterEach(waitForRunPipelineSettled);

  async function launch(extra: Record<string, unknown> = {}) {
    return app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: inlineManifest([INTEGRATION]),
        prompt: "do the thing",
        ...extra,
      }),
    });
  }

  it("records ONE warn run log naming the integration when its mcp-server cannot be resolved", async () => {
    // The fixture's integration references `<id>-server`, which is never
    // seeded — the spawn resolver drops it while the cascade is satisfied.
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);

    const res = await launch();
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, created.id), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe("warn");
    expect(rows[0]!.data?.integrationId).toBe(INTEGRATION);
    expect(rows[0]!.data?.reason).toBe("mcp_server_unresolved");
    expect(rows[0]!.message).toContain(INTEGRATION);
  });

  it("records a warn `unbound` marker, with its cause, when a non-required integration has no connection", async () => {
    // Absence degrades: the cascade binds `[]`, the run launches, and the
    // spawn resolver drops the integration as unbound rather than erroring.
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);

    const res = await launch();
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, created.id), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data?.reason).toBe("unbound");
    expect(rows[0]!.data?.code).toBe("not_connected");
    expect(rows[0]!.message).toContain("has no connection bound to this run (not_connected)");
    // Nothing served the actor: a degradation, not a choice.
    expect(rows[0]!.level).toBe("warn");
  });

  it("records an info `unbound` marker when the launch chose no connection", async () => {
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);

    const res = await launch({ connection_overrides: { [INTEGRATION]: [] } });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, created.id), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data?.code).toBe("integration_unbound");
    // A chosen absence, not a failure to start.
    expect(rows[0]!.level).toBe("info");
  });

  it("records `not_active`, not `unbound`, for a non-required integration switched off here", async () => {
    // The snapshot binds it to none (`[]`); the spawn's activation check runs first.
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    await seedDefaultOrgModel(ctx);
    await deactivatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, INTEGRATION);

    const res = await launch();
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const [run] = await db.select().from(runs).where(eq(runs.id, created.id));
    expect(run!.resolvedConnections).toEqual({ [INTEGRATION]: [] });
    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, created.id), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));
    expect(rows.map((r) => r.data?.reason)).toEqual(["not_active"]);
  });

  it("writes no marker when every declared integration spawns", async () => {
    // The SAME launch as above, with the referenced mcp-server actually seeded:
    // the integration resolves to a real spawn spec, so the marker must stay
    // silent. Declaring zero integrations would satisfy this test's name
    // vacuously and could not tell "suppressed on success" apart from "never
    // fires at all" — the failure mode a marker written unconditionally has.
    await seedConnectionTestIntegration(ctx, INTEGRATION);
    await seedIntegrationConnection(ctx, INTEGRATION);
    // The `mcp-server` the fixture integration references — the one piece the
    // connection fixtures deliberately leave out (their default gap IS the
    // missing server).
    await seedMcpServer({ id: `${INTEGRATION}-server`, orgId: ctx.orgId });
    await seedDefaultOrgModel(ctx);

    const res = await launch();
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, created.id), eq(runLogs.event, INTEGRATION_DROPPED_EVENT)));
    expect(rows).toHaveLength(0);
  });
});
