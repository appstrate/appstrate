// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: a launched run whose stored generation setting the model refuses
 * says so in `run_logs`.
 *
 * The unit half lives in `services/run-context-builder.test.ts`
 * (`buildRunContext` returns `droppedGenerationSettings`, and
 * `recordDroppedGenerationSettings` writes the rows). Both are called directly
 * there, so deleting the pipeline's call to the recorder would leave that
 * suite green. This one launches through the route and reads the row back.
 *
 * The model is DeepSeek Flash, not aliased: it takes reasoning level `high`
 * but refuses `medium` — the same fact the unit suite pins.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { runLogs, runs } from "@appstrate/db/schema";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";
import {
  createFakeOrchestrator,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import {
  seedAgent,
  seedOrgModel,
  seedOrgModelProviderKey,
  seedSpacePackage,
} from "../../helpers/seed.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { setDefaultModel } from "../../../src/services/org-models.ts";
import { GENERATION_SETTING_DROPPED_EVENT } from "../../../src/services/run-context-builder.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

const AGENT = "@genmark/agent";
const MODEL_LABEL = "Marker Flash";

describe("run launch — dropped-generation-setting marker in run_logs", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "genmark" });
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: { name: AGENT, version: "0.1.0", type: "agent" },
      draftContent: "Do the thing.",
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    const cred = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      providerId: "deepseek",
      apiShape: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test",
    });
    const model = await seedOrgModel({
      orgId: ctx.orgId,
      credentialId: cred.id,
      label: MODEL_LABEL,
      modelId: "deepseek-flash",
      aliased: false,
    });
    await setDefaultModel(ctx.orgId, model.id);
  });

  // The trigger is fire-and-forget; drain here (not at the tail of a body) so a
  // failing assertion cannot leave background writes racing the next truncate.
  afterEach(waitForRunPipelineSettled);

  /** Store `stored` as the space default, launch, return the run and its marker rows. */
  async function launchWithSpaceDefault(stored: ModelGenerationSettings) {
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { generationConfig: stored });
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [run] = await db.select().from(runs).where(eq(runs.id, id));
    const rows = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, id), eq(runLogs.event, GENERATION_SETTING_DROPPED_EVENT)));
    return { run: run!, rows };
  }

  it("records ONE warn run log naming the refused space default", async () => {
    const { run, rows } = await launchWithSpaceDefault({ reasoning_level: "medium" });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe("warn");
    expect(rows[0]!.data).toEqual({
      platform: true,
      setting: "reasoning_level",
      value: "medium",
      model: MODEL_LABEL,
      reason: "refused_by_model",
    });
    expect(run.generationConfig?.reasoning_level).toBeUndefined();
  });

  it("writes no marker when the model accepts the stored setting", async () => {
    // The SAME launch with a level the model takes. The run carrying it proves
    // the stored layer was read, so zero rows means "suppressed on success"
    // rather than "the setting never reached the pipeline".
    const { run, rows } = await launchWithSpaceDefault({ reasoning_level: "high" });

    expect(rows).toHaveLength(0);
    expect(run.generationConfig?.reasoning_level).toBe("high");
  });
});
