// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule never spends a personal model connection (#1875, #2451). Its fire
 * has no payer: the run is served by an organization connection of the model's
 * configuration, even when the member who owns the schedule holds a personal key
 * there, and a model no organization connection serves is refused rather than
 * served by that key.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { modelProviderCredentials, runs, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedModelConfigFor,
  seedOrgModelProviderKey,
  seedOrgModelProviderOAuth,
  seedSchedule,
} from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import {
  TEST_OAUTH_HOOKS_PROVIDER_ID,
  TEST_OAUTH_MODEL_ID,
  TEST_OAUTH_PROVIDER_ID,
} from "../../helpers/test-oauth-provider.ts";
import {
  createFakeOrchestrator,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

const app = getTestApp(); // boots the model and provider registries

const AGENT_ID = "@schedpayer/scheduled-agent";

describe("schedule payer — organization credentials only", () => {
  let ctx: TestContext;

  beforeAll(() => {
    seedTestModelProviders();
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
    seedTestModelProviders();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "schedpayer" });
    await seedAgent({
      id: AGENT_ID,
      homeSpaceId: ctx.defaultSpaceId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT_ID,
        version: "0.1.0",
        type: "agent",
        description: "Agent fired by a schedule",
      },
      draftContent: "Say hello.",
    });
    await activatePackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT_ID);
  });

  afterEach(waitForRunPipelineSettled);

  const openaiConfig = () => seedModelConfigFor(ctx.orgId, "openai");

  /** An organization key on the openai configuration. */
  function seedOrgKey(): Promise<string> {
    return openaiConfig().then((configId) =>
      createApiKeyCredential({
        mayCreateConfig: true,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        ownerUserId: null,
        label: "Org key",
        providerId: "openai",
        apiKey: "sk-org-test-key",
        configId,
      }),
    );
  }

  /** A `gpt-5.5` model of the openai configuration. */
  async function seedGptModel(label: string): Promise<string> {
    return createOrgModel(ctx.orgId, label, "gpt-5.5", ctx.user.id, await openaiConfig());
  }

  const postSchedule = (body: Record<string, unknown>) =>
    app.request(`/api/agents/${AGENT_ID}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", version_override: "draft", ...body }),
    });

  /** A personal openai key held by `ownerId`. */
  async function seedPersonalKey(ownerId: string): Promise<string> {
    const row = await seedOrgModelProviderKey({
      orgId: ctx.orgId,
      createdBy: ownerId,
      ownerUserId: ownerId,
      label: "member-key",
      providerId: "openai",
      apiKey: "sk-personal-member",
    });
    return row.id;
  }

  /** Fire a schedule owned by `ownerId` once; returns the run it created. */
  async function fireAs(ownerId: string) {
    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ownerId,
      input: {},
      versionOverride: "draft",
    });
    await triggerScheduledRun(schedule.id);
    const [run] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    return run!;
  }

  it("a scheduled run spends the org credential even when its owner holds a personal key", async () => {
    const credentialId = await seedOrgKey();
    const modelDbId = await seedGptModel("Team GPT");
    await setDefaultModel(ctx.orgId, modelDbId);
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id);

    const run = await fireAs(member.user.id);
    expect(run.status).not.toBe("failed");
    expect(run.modelCredentialId).toBe(credentialId);
    await waitForRunPipelineSettled();
  });

  it("fails a fire whose default lost its organization connection rather than serving it with the owner's personal key", async () => {
    const credentialId = await seedOrgKey();
    const modelDbId = await seedGptModel("Shared GPT");
    await setDefaultModel(ctx.orgId, modelDbId);
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id);
    await db.delete(modelProviderCredentials).where(eq(modelProviderCredentials.id, credentialId));

    const run = await fireAs(member.user.id);
    expect(run.status).toBe("failed");
    expect(run.modelCredentialId).toBeNull();
    await waitForRunPipelineSettled();
  });

  it("refuses a schedule whose model override is served only by members' own connections", async () => {
    const modelDbId = await seedGptModel("Each member's GPT");
    await seedPersonalKey(ctx.user.id);

    const res = await postSchedule({ model_id_override: modelDbId });

    const body = (await res.json()) as { code: string; detail: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe("model_credential_required");
    expect(body.detail).toContain("No organization connection serves model");
  });

  it("accepts a schedule on a model an organization subscription serves, not on one only the caller's own serves", async () => {
    const orgSubscription = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_PROVIDER_ID,
      createdBy: ctx.user.id,
    });
    const served = await createOrgModel(
      ctx.orgId,
      "Team plan",
      TEST_OAUTH_MODEL_ID,
      ctx.user.id,
      orgSubscription.configId!,
    );
    // test-oauth-hooks has a configuration of its own: only the caller's
    // subscription is filed there.
    const own = await seedOrgModelProviderOAuth({
      orgId: ctx.orgId,
      providerId: TEST_OAUTH_HOOKS_PROVIDER_ID,
      createdBy: ctx.user.id,
      ownerUserId: ctx.user.id,
    });
    const personalOnly = await createOrgModel(
      ctx.orgId,
      "Own plan",
      "hooks-model",
      ctx.user.id,
      own.configId!,
    );

    const accepted = await postSchedule({ model_id_override: served });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { model_id_override: string }).model_id_override).toBe(
      served,
    );

    const refused = await postSchedule({ model_id_override: personalOnly });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("refuses a schedule whose organization default lost its organization connection", async () => {
    const credentialId = await seedOrgKey();
    await setDefaultModel(ctx.orgId, await seedGptModel("Default GPT"));
    await db.delete(modelProviderCredentials).where(eq(modelProviderCredentials.id, credentialId));

    const res = await postSchedule({});

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("refuses a schedule whose space package model has no organization connection", async () => {
    const modelDbId = await seedGptModel("Space GPT");
    await db
      .update(spacePackages)
      .set({ modelId: modelDbId })
      .where(
        and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, AGENT_ID)),
      );

    const res = await postSchedule({});

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("refuses to enable a schedule whose effective model has no organization connection, and still lets it be disabled", async () => {
    const modelDbId = await seedGptModel("Override GPT");
    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelIdOverride: modelDbId,
      enabled: false,
    });
    const patch = (body: Record<string, unknown>) =>
      app.request(`/api/schedules/${schedule.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const enable = await patch({ enabled: true });
    expect(enable.status).toBe(409);
    expect(((await enable.json()) as { code: string }).code).toBe("model_credential_required");

    const disable = await patch({ enabled: false });
    expect(disable.status).toBe(200);
  });
});
