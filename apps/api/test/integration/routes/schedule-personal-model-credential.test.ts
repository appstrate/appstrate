// SPDX-License-Identifier: Apache-2.0

/**
 * A schedule never spends a personal model credential (#1875). Its fire has no
 * payer: the run is served by the organization's binding, even when the member
 * who owns the schedule holds a personal key for the model's provider, and an
 * unbound model is refused rather than served by that key.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { orgModels, runs, spacePackages } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { authHeaders } from "../../helpers/auth.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, memberContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedOrgModelProviderKey, seedSchedule } from "../../helpers/seed.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
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
    seedTestModelProviders({ fixedEndpoint: ["openai", "anthropic"] });
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

  it("refuses a schedule whose model override is served only by members' own credentials", async () => {
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Each member's GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });

    const res = await app.request(`/api/agents/${AGENT_ID}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({
        cron_expression: "0 9 * * *",
        version_override: "draft",
        model_id_override: row!.id,
      }),
    });

    const body = (await res.json()) as { code: string; detail: string };
    expect(res.status).toBe(409);
    expect(body.code).toBe("model_credential_required");
    expect(body.detail).toContain("bound to an organization credential");
  });

  it("refuses a schedule whose organization default is an unbound model", async () => {
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Default GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });
    await setDefaultModel(ctx.orgId, row!.id);

    const res = await app.request(`/api/agents/${AGENT_ID}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", version_override: "draft" }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("refuses a schedule whose space package model is an unbound model", async () => {
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Space GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });
    await db
      .update(spacePackages)
      .set({ modelId: row!.id })
      .where(
        and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, AGENT_ID)),
      );

    const res = await app.request(`/api/agents/${AGENT_ID}/schedules`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 9 * * *", version_override: "draft" }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("model_credential_required");
  });

  it("refuses to enable a schedule whose effective model is unbound, and still lets it be disabled", async () => {
    const [row] = await db
      .insert(orgModels)
      .values({
        orgId: ctx.orgId,
        label: "Override GPT",
        modelId: "gpt-5.5",
        providerId: "openai",
        credentialId: null,
        aliased: false,
        source: "custom",
        createdBy: ctx.user.id,
      })
      .returning({ id: orgModels.id });
    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelIdOverride: row!.id,
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

  it("refuses to unbind a model a schedule overrides with", async () => {
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
    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      modelIdOverride: modelDbId,
    });

    const res = await app.request(`/api/models/${modelDbId}`, {
      method: "PATCH",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify({ credentialId: null }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; detail: string; schedule_ids: string[] };
    expect(body.code).toBe("model_scheduled");
    expect(body.schedule_ids).toEqual([schedule.id]);
    expect(body.detail).not.toContain(schedule.id);
    const [row] = await db.select().from(orgModels).where(eq(orgModels.id, modelDbId));
    expect(row!.credentialId).toBe(credentialId);
  });
  describe("unbinding a model enabled schedules run", () => {
    /** A model bound to an organization key. */
    async function seedBoundModel(label: string): Promise<{ id: string; credentialId: string }> {
      const credentialId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        ownerUserId: null,
        label: `${label} key`,
        providerId: "openai",
        apiKey: "sk-org-test-key",
      });
      const id = await createOrgModel(ctx.orgId, label, "gpt-5.5", ctx.user.id, { credentialId });
      return { id, credentialId };
    }

    const seedAgentSchedule = (opts: { modelIdOverride?: string; enabled?: boolean } = {}) =>
      seedSchedule({
        packageId: AGENT_ID,
        orgId: ctx.orgId,
        spaceId: ctx.defaultSpaceId,
        userId: ctx.user.id,
        ...opts,
      });

    const send = (method: string, path: string, body: Record<string, unknown>) =>
      app.request(path, {
        method,
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    async function expectScheduled(res: Response, scheduleIds: string[]): Promise<void> {
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; schedule_ids: string[] };
      expect(body.code).toBe("model_scheduled");
      expect(body.schedule_ids).toEqual(scheduleIds);
    }

    it("refuses to unbind the organization default enabled schedules inherit", async () => {
      const bound = await seedBoundModel("Team GPT");
      await setDefaultModel(ctx.orgId, bound.id);
      const schedule = await seedAgentSchedule();

      const res = await send("PATCH", `/api/models/${bound.id}`, { credentialId: null });

      await expectScheduled(res, [schedule.id]);
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, bound.id));
      expect(row!.credentialId).toBe(bound.credentialId);
    });

    it("refuses to unbind the agent model enabled schedules run in their space", async () => {
      const bound = await seedBoundModel("Team GPT");
      await db
        .update(spacePackages)
        .set({ modelId: bound.id })
        .where(
          and(eq(spacePackages.spaceId, ctx.defaultSpaceId), eq(spacePackages.packageId, AGENT_ID)),
        );
      const schedule = await seedAgentSchedule();

      const res = await send("PATCH", `/api/models/${bound.id}`, { credentialId: null });

      await expectScheduled(res, [schedule.id]);
    });

    it("unbinds a model only disabled schedules would run", async () => {
      const bound = await seedBoundModel("Team GPT");
      await setDefaultModel(ctx.orgId, bound.id);
      await seedAgentSchedule({ enabled: false });

      const res = await send("PATCH", `/api/models/${bound.id}`, { credentialId: null });

      expect(res.status).toBe(200);
      const [row] = await db.select().from(orgModels).where(eq(orgModels.id, bound.id));
      expect(row!.credentialId).toBeNull();
    });
  });
});
