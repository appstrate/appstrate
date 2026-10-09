// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule never spends a personal model credential (#1875). Its fire has no
 * payer: the run is served by the organization's binding, even when the member
 * who owns the schedule holds a personal key for the model's provider, and an
 * unbound model is refused rather than served by that key.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedOrgModelProviderKey, seedSchedule } from "../../helpers/seed.ts";
import {
  createFakeOrchestrator,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";
import { activatePackage } from "../../../src/services/space-packages.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";

getTestApp(); // boots the model and provider registries

const AGENT_ID = "@schedpayer/scheduled-agent";

describe("schedule payer — organization credentials only", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
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

  /** A personal openai key held by `ownerId`, seeded directly (see run-personal-model-credential). */
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
    const credentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      ownerUserId: null,
      label: "Org key",
      providerId: "openai",
      apiKey: "sk-org-test-key",
    });
    const modelDbId = await createOrgModel(ctx.orgId, "Team GPT", "gpt-5.5", ctx.user.id, {
      credentialId,
    });
    await setDefaultModel(ctx.orgId, modelDbId);
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id);

    const run = await fireAs(member.user.id);
    expect(run.status).not.toBe("failed");
    expect(run.modelCredentialId).toBe(credentialId);
    await waitForRunPipelineSettled();
  });

  it("refuses an unbound model rather than serving it with the owner's personal key", async () => {
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
    const member = await memberContext(ctx, "member", "builder");
    await seedPersonalKey(member.user.id);

    const run = await fireAs(member.user.id);
    expect(run.status).toBe("failed");
    expect(run.modelCredentialId).toBeNull();
    await waitForRunPipelineSettled();
  });
});
