// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's diagnostics warn BEFORE a run that the model set for the agent
 * is no longer usable and that the organisation default will serve. They share
 * the launch's cascade (`resolveModelCascade`), so the run that follows records
 * the matching `model_fallback` marker (`run-model-fallback-marker.test.ts`),
 * and the launch's credential test, so a model no credential serves blocks here
 * as the launch refuses it.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { orgModels, runLogs } from "@appstrate/db/schema";
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

const AGENT = "@modeldiag/agent";
const DEFAULT_LABEL = "Org Default";

interface DiagnosticsBody {
  status: "healthy" | "warning" | "blocking";
  warning_count: number;
  can_launch: boolean;
  diagnostics: Array<{
    code: string;
    severity: "blocking" | "warning";
    correction: { destination: string; section: string | null; params: Record<string, string> };
  }>;
}

describe("GET /api/agents/:scope/:name/diagnostics — pinned model unavailable", () => {
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
    ctx = await createTestContext({ orgSlug: "modeldiag" });
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
    pinnedModelId = (await model("Agent Pin", "deepseek-chat")).id;
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: pinnedModelId });
  });

  // The parity run is fire-and-forget; drain it before the next truncate.
  afterEach(waitForRunPipelineSettled);

  async function getDiagnostics() {
    const res = await app.request(`/api/agents/${AGENT}/diagnostics`, {
      method: "GET",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as DiagnosticsBody;
  }

  async function launchedFallbackMarkers() {
    const res = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    return db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, id), eq(runLogs.event, MODEL_FALLBACK_EVENT)));
  }

  it("is healthy while the agent's model loads, and the run records no marker", async () => {
    const body = await getDiagnostics();
    expect(body).toMatchObject({ status: "healthy", warning_count: 0, diagnostics: [] });
    expect(await launchedFallbackMarkers()).toHaveLength(0);
  });

  it("warns, without blocking, when the model is switched off — and the run falls back the same way", async () => {
    await updateOrgModel(ctx.orgId, pinnedModelId, { enabled: false });

    const body = await getDiagnostics();
    expect(body.status).toBe("warning");
    expect(body.can_launch).toBe(true);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0]).toMatchObject({
      code: "pinned_model_unavailable",
      severity: "warning",
      correction: {
        destination: "configuration",
        section: "model",
        params: { default_model: DEFAULT_LABEL },
      },
    });

    const markers = await launchedFallbackMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.data).toMatchObject({ pinnedModelId, model: DEFAULT_LABEL });
  });

  it("warns when the pin names a model that no longer exists", async () => {
    await deleteOrgModel(ctx.orgId, pinnedModelId);
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: pinnedModelId });

    const body = await getDiagnostics();
    expect(body.diagnostics.map((d) => d.code)).toEqual(["pinned_model_unavailable"]);
  });

  it("does not warn when the agent has no model of its own (the default is the plan)", async () => {
    await seedSpacePackage(ctx.defaultSpaceId, AGENT, { modelId: null });

    const body = await getDiagnostics();
    expect(body.status).toBe("healthy");
  });
});

describe("GET /api/agents/:scope/:name/diagnostics — model no credential serves", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "modelcred" });
    await seedAgent({
      id: AGENT,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: { name: AGENT, version: "0.1.0", type: "agent" },
      draftContent: "Do the thing.",
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT);
    // An organization model bound to no credential: each payer brings their own.
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Shared GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });
    await setDefaultModel(ctx.orgId, row!.id);
  });

  it("blocks with the launch's refusal when the payer holds no credential for it", async () => {
    const res = await app.request(`/api/agents/${AGENT}/diagnostics`, {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticsBody;
    expect(body.status).toBe("blocking");
    expect(body.can_launch).toBe(false);
    expect(body.diagnostics).toEqual([
      expect.objectContaining({
        code: "model_credential_required",
        severity: "blocking",
        correction: {
          destination: "configuration",
          section: "model",
          params: { model: "Shared GPT" },
        },
      }),
    ]);

    const launch = await app.request(`/api/agents/${AGENT}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(launch.status).toBe(409);
    expect(((await launch.json()) as { code: string }).code).toBe("model_credential_required");
  });
});
