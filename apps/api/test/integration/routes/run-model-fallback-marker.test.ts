// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: a run whose pinned model no longer loads falls back to a default
 * (`resolveModelCascade`) and says so in `run_logs`. Without the
 * marker the run is indistinguishable from one that ran on the model its
 * agent or schedule was set to.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { runLogs, runs } from "@appstrate/db/schema";
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
import {
  deleteOrgModel,
  setDefaultModel,
  updateOrgModel,
} from "../../../src/services/org-models.ts";
import { MODEL_FALLBACK_EVENT } from "../../../src/services/run-context-builder.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

const AGENT = "@modelmark/agent";
const DEFAULT_LABEL = "Org Default";
const PINNED_LABEL = "Agent Pin";

describe("run launch — model-fallback marker in run_logs", () => {
  let ctx: TestContext;
  let pinnedModelId: string;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "modelmark" });
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
    const model = (label: string, modelId: string) =>
      seedOrgModel({ orgId: ctx.orgId, credentialId: cred.id, label, modelId, aliased: false });
    await setDefaultModel(ctx.orgId, (await model(DEFAULT_LABEL, "deepseek-flash")).id);
    pinnedModelId = (await model(PINNED_LABEL, "deepseek-chat")).id;
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: pinnedModelId });
  });

  // The trigger is fire-and-forget; drain here (not at the tail of a body) so a
  // failing assertion cannot leave background writes racing the next truncate.
  afterEach(waitForRunPipelineSettled);

  async function launch() {
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
      .where(and(eq(runLogs.runId, id), eq(runLogs.event, MODEL_FALLBACK_EVENT)));
    return { run: run!, rows };
  }

  const fallbackMarker = () => ({
    platform: true,
    pinnedModelId,
    model: DEFAULT_LABEL,
    reason: "pinned_model_unavailable",
  });

  it("records ONE warn run log when the agent's pinned model is switched off", async () => {
    await updateOrgModel(ctx.orgId, pinnedModelId, { enabled: false });

    const { run, rows } = await launch();

    expect(run.modelLabel).toBe(DEFAULT_LABEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe("warn");
    expect(rows[0]!.data).toEqual(fallbackMarker());
  });

  it("records the marker for a pin that names no model row", async () => {
    // Deleting a model clears the settings that name it, so the dangling pin is
    // written back by hand: the column is free text and nothing else guards it.
    await deleteOrgModel(ctx.orgId, pinnedModelId);
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: pinnedModelId });

    const { run, rows } = await launch();

    expect(run.modelLabel).toBe(DEFAULT_LABEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toEqual(fallbackMarker());
  });

  it("writes no marker for a pin that resolves under another spelling of its id", async () => {
    // The pin column is free text and the lookup is on a uuid column: an
    // upper-cased id finds the same row, so this is not a fallback.
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: pinnedModelId.toUpperCase() });

    const { run, rows } = await launch();

    expect(run.modelLabel).toBe(PINNED_LABEL);
    expect(rows).toHaveLength(0);
  });

  it("writes no marker when the pinned model resolves", async () => {
    const { run, rows } = await launch();

    expect(run.modelLabel).toBe(PINNED_LABEL);
    expect(rows).toHaveLength(0);
  });
});
