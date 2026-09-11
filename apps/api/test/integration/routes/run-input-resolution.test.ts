// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the unified input resolution across the three run
 * origins that reach it (`PUT .../input-settings` write guard, `POST .../run`, the
 * scheduler fire path).
 *
 * What each test pins is the value that reaches `runs.input` — the row the
 * runtime is handed — not an intermediate object, so a layer that resolves
 * correctly but never gets persisted still fails.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedSchedule } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/space-packages.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { triggerScheduledRun } from "../../../src/services/scheduler.ts";
import { _setOrchestratorForTesting } from "../../../src/services/orchestrator/index.ts";
import {
  createFakeOrchestrator,
  waitForRunPipelineSettled,
} from "../../helpers/run-connection-fixtures.ts";

const app = getTestApp();

const AGENT_ID = "@inputorg/layered-agent";

/**
 * `tone` carries an author default, `folder` is overridden per space,
 * `subject` is required with no default — the three shapes the four layers
 * have to tell apart.
 */
const INPUT_SCHEMA = {
  type: "object",
  properties: {
    tone: { type: "string", default: "neutral" },
    folder: { type: "string", default: "inbox" },
    subject: { type: "string" },
  },
  required: ["subject"],
} as const;

describe("run input resolution — author / editor / schedule / caller layers", () => {
  let ctx: TestContext;

  beforeAll(() => {
    _setOrchestratorForTesting(createFakeOrchestrator());
  });

  afterAll(() => {
    _setOrchestratorForTesting(null);
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inputorg" });
  });

  async function seedRunnableAgent(): Promise<void> {
    await seedAgent({
      id: AGENT_ID,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
      draftManifest: {
        name: AGENT_ID,
        version: "0.1.0",
        type: "agent",
        description: "Agent exercising the input resolution layers",
        input: { schema: INPUT_SCHEMA },
      },
      draftContent: "Write a {{tone}} message about {{subject}}.",
    });
    await installPackage({ orgId: ctx.orgId, spaceId: ctx.defaultSpaceId }, AGENT_ID);

    const credentialId = await createApiKeyCredential({
      orgId: ctx.orgId,
      userId: ctx.user.id,
      label: "Layered credential",
      providerId: "openai",
      apiKey: "sk-test-not-a-real-key",
    });
    const modelDbId = await createOrgModel(
      ctx.orgId,
      "Layered GPT",
      "gpt-5.5",
      ctx.user.id,
      credentialId,
    );
    await setDefaultModel(ctx.orgId, modelDbId);
  }

  /** Write the per-space input settings through the real route. */
  async function putInputSettings(body: {
    values?: Record<string, unknown>;
    locked_fields?: string[];
  }): Promise<Response> {
    return app.request(`/api/agents/${AGENT_ID}/input-settings`, {
      method: "PUT",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function triggerRun(body: Record<string, unknown>): Promise<Response> {
    return app.request(`/api/agents/${AGENT_ID}/run?version=draft`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** The persisted input of the run the trigger response identifies. */
  async function persistedInput(res: Response): Promise<Record<string, unknown>> {
    const body = (await res.json()) as { id?: string };
    const [row] = await db.select({ input: runs.input }).from(runs).where(eq(runs.id, body.id!));
    return (row!.input ?? {}) as Record<string, unknown>;
  }

  // ── author default ────────────────────────────────────────

  it("an author default with no other layer reaches the run", async () => {
    await seedRunnableAgent();

    const res = await triggerRun({ input: { subject: "hello" } });
    expect(res.status).toBe(201);

    expect(await persistedInput(res)).toEqual({
      tone: "neutral",
      folder: "inbox",
      subject: "hello",
    });
    await waitForRunPipelineSettled();
  });

  // ── editor default ────────────────────────────────────────

  it("an editor default beats the author default and reaches the run", async () => {
    await seedRunnableAgent();
    expect(
      (await putInputSettings({ values: { folder: "archive" }, locked_fields: [] })).status,
    ).toBe(200);

    const res = await triggerRun({ input: { subject: "hello" } });
    expect(res.status).toBe(201);

    const input = await persistedInput(res);
    expect(input.folder).toBe("archive");
    expect(input.tone).toBe("neutral");
    await waitForRunPipelineSettled();
  });

  it("a caller can still override an UNLOCKED editor default", async () => {
    await seedRunnableAgent();
    await putInputSettings({ values: { folder: "archive" }, locked_fields: [] });

    const res = await triggerRun({ input: { subject: "hello", folder: "sent" } });
    expect(res.status).toBe(201);
    expect((await persistedInput(res)).folder).toBe("sent");
    await waitForRunPipelineSettled();
  });

  // ── schedule values ───────────────────────────────────────

  it("a schedule value beats the editor default on the fire path", async () => {
    await seedRunnableAgent();
    await putInputSettings({ values: { folder: "archive" }, locked_fields: [] });

    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      input: { folder: "scheduled", subject: "weekly digest" },
    });

    await triggerScheduledRun(
      schedule.id,
      AGENT_ID,
      { type: "user", id: ctx.user.id },
      ctx.orgId,
      ctx.defaultSpaceId,
      { folder: "scheduled", subject: "weekly digest" },
      { versionOverride: "draft" },
    );

    const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    expect(row!.status).not.toBe("failed");
    expect(row!.input).toEqual({
      tone: "neutral",
      folder: "scheduled",
      subject: "weekly digest",
    });
    await waitForRunPipelineSettled();
  });

  it("a schedule value on a locked field produces a visible failed run", async () => {
    await seedRunnableAgent();
    await putInputSettings({ values: { folder: "archive" }, locked_fields: ["folder"] });

    const schedule = await seedSchedule({
      packageId: AGENT_ID,
      orgId: ctx.orgId,
      spaceId: ctx.defaultSpaceId,
      userId: ctx.user.id,
      input: { folder: "scheduled", subject: "weekly digest" },
    });

    await triggerScheduledRun(
      schedule.id,
      AGENT_ID,
      { type: "user", id: ctx.user.id },
      ctx.orgId,
      ctx.defaultSpaceId,
      { folder: "scheduled", subject: "weekly digest" },
      { versionOverride: "draft" },
    );

    const [row] = await db.select().from(runs).where(eq(runs.scheduleId, schedule.id));
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("folder");
    await waitForRunPipelineSettled();
  });

  // ── locked fields ─────────────────────────────────────────

  it("POST /run with a caller value on a locked field returns 400 locked_input_field", async () => {
    await seedRunnableAgent();
    await putInputSettings({ values: { folder: "archive" }, locked_fields: ["folder"] });

    const res = await triggerRun({ input: { subject: "hello", folder: "sent" } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("locked_input_field");
    expect(body.detail).toContain("folder");

    // The refusal happens before the run row is inserted.
    const rows = await db.select().from(runs).where(eq(runs.packageId, AGENT_ID));
    expect(rows).toHaveLength(0);
  });

  it("a locked field still resolves from its editor value on a run that omits it", async () => {
    await seedRunnableAgent();
    await putInputSettings({ values: { folder: "archive" }, locked_fields: ["folder"] });

    const res = await triggerRun({ input: { subject: "hello" } });
    expect(res.status).toBe(201);
    expect((await persistedInput(res)).folder).toBe("archive");
    await waitForRunPipelineSettled();
  });

  // ── write-time guard: required + locked + empty ───────────

  it("refuses to lock a required field that has no effective value", async () => {
    await seedRunnableAgent();

    const res = await putInputSettings({ values: {}, locked_fields: ["subject"] });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; detail?: string };
    expect(body.code).toBe("locked_required_field_empty");
    expect(body.detail).toContain("subject");
  });

  it("allows locking a required field once it has a stored value", async () => {
    await seedRunnableAgent();

    const res = await putInputSettings({
      values: { subject: "fixed" },
      locked_fields: ["subject"],
    });
    expect(res.status).toBe(200);

    // And that value is what the run receives, with no `subject` asked at launch.
    const run = await triggerRun({ input: {} });
    expect(run.status).toBe(201);
    expect((await persistedInput(run)).subject).toBe("fixed");
    await waitForRunPipelineSettled();
  });

  it("allows locking an OPTIONAL field with no value at all", async () => {
    await seedRunnableAgent();
    const res = await putInputSettings({ values: {}, locked_fields: ["folder"] });
    expect(res.status).toBe(200);
  });
});
