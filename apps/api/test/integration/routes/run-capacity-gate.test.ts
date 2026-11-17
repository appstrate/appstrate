// SPDX-License-Identifier: Apache-2.0

/**
 * Readiness by capacity: while the boot's orphan pass and first runtime
 * initialisation are running, reads answer and every run launch is refused with
 * 503 `run_capacity_starting` BEFORE anything is written (no run row, no inline
 * shadow package). The refusal lives in the services, so the REST routes, the
 * MCP / chat doors that re-enter them and the scheduler share it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { authHeaders, createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent } from "../../helpers/seed.ts";
import {
  createFakeOrchestrator,
  inlineAgentManifest,
  seedDefaultOrgModel,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import {
  _resetRunCapacityReadyForTesting,
  markRunCapacityReady,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";
import { packages, runs } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { resetRateLimiters } from "../../../src/middleware/rate-limit.ts";
import { flushRedis } from "../../helpers/redis.ts";

const app = getTestApp();
const AGENT = "@caporg/cap-agent";

describe("run capacity gate", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });
  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await flushRedis();
    resetRateLimiters();
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "caporg" });
    await seedDefaultOrgModel(ctx);
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
  });

  // The preload marks the flag ready for the whole process: restore it.
  afterEach(() => markRunCapacityReady());

  const json = { "Content-Type": "application/json" };
  const launchAgent = () =>
    app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), ...json },
      body: JSON.stringify({ input: {} }),
    });
  const launchInline = () =>
    app.request("/api/runs/inline", {
      method: "POST",
      headers: { ...authHeaders(ctx), ...json },
      body: JSON.stringify({ manifest: inlineAgentManifest(), prompt: "hello" }),
    });

  it("serves reads but refuses both launches with 503 run_capacity_starting, writing nothing", async () => {
    _resetRunCapacityReadyForTesting();

    const read = await app.request("/api/agents", { headers: authHeaders(ctx) });
    expect(read.status).toBe(200);

    for (const launch of [launchAgent, launchInline]) {
      const res = await launch();
      const text = await res.clone().text();
      expect(res.status, text).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        status: 503,
        code: "run_capacity_starting",
        title: "Service Unavailable",
        detail:
          "Run execution is still starting up (orphan cleanup and runtime initialisation); retry in a few seconds.",
      });
    }

    expect(await db.select().from(runs)).toHaveLength(0);
    expect(await db.select().from(packages).where(eq(packages.ephemeral, true))).toHaveLength(0);
  });

  it("lets both launches through once markRunCapacityReady() has run", async () => {
    _resetRunCapacityReadyForTesting();
    markRunCapacityReady();

    const agentRes = await launchAgent();
    expect(agentRes.status, await agentRes.clone().text()).toBe(201);
    await waitForRunPipelineSettled();

    const inlineRes = await launchInline();
    expect(inlineRes.status, await inlineRes.clone().text()).toBe(201);
    await waitForRunPipelineSettled();
  });
});
