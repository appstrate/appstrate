// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { auditEvents, runLogs, runs } from "@appstrate/db/schema";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import {
  seedAgent,
  seedRun,
  seedRunLog,
  seedApplication,
  seedEndUser,
  seedApiKey,
  seedSchedule,
} from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { createApiKeyCredential } from "../../../src/services/model-providers/credentials.ts";
import { createOrgModel, setDefaultModel } from "../../../src/services/org-models.ts";
import { waitForInFlight } from "../../../src/services/run-tracker.ts";
import {
  _setOrchestratorForTesting,
  type RunOrchestrator,
  type WorkloadHandle,
  type WorkloadSpec,
  type IsolationBoundary,
  type CleanupReport,
  type StopResult,
} from "../../../src/services/orchestrator/index.ts";

const app = getTestApp();

describe("Runs API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "runorg" });
  });

  // ─── POST /api/agents/:scope/:name/run — input validation ──

  describe("POST /api/agents/:scope/:name/run — input validation", () => {
    const inputSchema = {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
        count: { type: "number", description: "Optional count" },
      },
      required: ["email"],
    };

    async function seedAgentWithInput() {
      const agent = await seedAgent({
        id: "@runorg/input-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/input-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent with required input",
          input: { schema: inputSchema },
        },
        draftContent: "Process the email: {{email}}",
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/input-agent",
      );
      return agent;
    }

    it("returns 400 when required input field is missing", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { count: 5 } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain("email");
    });

    it("accepts an encoded @ scope from standards-compliant clients", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/%40runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { count: 5 } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("email");
    });

    it("does not treat encoded slashes as scoped package separators", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/%40runorg%2Finput-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "ops@example.com" } }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("API endpoint not found");
    });

    it("returns 400 when input is omitted entirely and schema has required fields", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is empty string", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "" } }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is null", async () => {
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: null } }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects a non-object `config` body field with 400 invalid_request", async () => {
      // The route accepts an optional `config: Record<string, unknown>`
      // override that is deep-merged with the persisted per-app
      // config. Anything that isn't a JSON object (array, string,
      // number) must be refused before the merge runs — the SOTA
      // contract (OpenAI Assistants `runs.create`) is "object or
      // omitted, never any other shape".
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "a@b.c" }, config: ["not", "an", "object"] }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("config");
    });

    it("rejects `config: null` with 400 invalid_request", async () => {
      // Top-level `null` is ambiguous: deepMergeConfig short-circuits on a
      // falsy override (treats null as "no override"), but the schedule
      // route uses `null` to *clear* an override. We force the caller to
      // pick — omit the field to inherit defaults, or send `{}` for an
      // empty override.
      await seedAgentWithInput();

      const res = await app.request("/api/agents/@runorg/input-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "a@b.c" }, config: null }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("config");
    });

    it("rejects a merged config that violates the manifest schema with 400 invalid_config", async () => {
      // The persisted config is vetted by `resolveRunPreflight`. A per-run
      // override could push the merged result out of schema, and the CLI's
      // local-run path already gates this — the server must too. This test
      // pins the contract: install a config schema, send an override that
      // breaks `format: email` after merge, expect a 400.
      const configSchema = {
        type: "object",
        properties: {
          contact: { type: "string", format: "email" },
          notify: { type: "boolean" },
        },
        required: ["contact"],
      } as const;
      await seedAgent({
        id: "@runorg/cfg-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/cfg-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent with config schema",
          config: { schema: configSchema },
        },
        draftContent: "Send to {{contact}}",
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/cfg-agent",
        { contact: "ops@example.com", notify: true },
      );

      const res = await app.request("/api/agents/@runorg/cfg-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ config: { contact: "not-an-email" } }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("invalid_config");
      expect(body.detail).toContain("contact");
    });
  });

  // ─── POST /api/agents/:scope/:name/run — modelId override ──
  //
  // Regression for #544: an explicit, caller-supplied `modelId` that is not a
  // real model reference must produce a clean 404, not an unhandled 500. A
  // non-UUID value (e.g. a human-readable model name) used to reach the
  // `org_models.id` uuid column and make Postgres raise
  // `invalid input syntax for type uuid`, which bubbled up as a 500.
  describe("POST /api/agents/:scope/:name/run — modelId override", () => {
    async function seedNoInputAgent() {
      await seedAgent({
        id: "@runorg/model-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/model-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent without input schema",
        },
        draftContent: "Do the thing.",
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/model-agent",
      );
    }

    it("returns 404 (not 500) for a non-UUID modelId", async () => {
      await seedNoInputAgent();

      const res = await app.request("/api/agents/@runorg/model-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, modelId: "gpt-5.5" }),
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain("gpt-5.5");
    });

    it("returns 404 for a well-formed but unknown modelId UUID", async () => {
      await seedNoInputAgent();

      const res = await app.request("/api/agents/@runorg/model-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({
          input: {},
          modelId: "5af6e114-c264-479d-8c13-ed981b96e972",
        }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ─── POST /api/agents/:scope/:name/run — missing model credential ──
  //
  // Fail-fast guard: a resolved model whose credential has an empty API key
  // (the `SYSTEM_PROVIDER_KEYS`-stub / blank-secret case) used to slip past
  // resolution and leave the run stuck in `running` until the timeout ceiling
  // — the LLM call 401s and the SDK retries silently. buildRunContext now
  // rejects at kickoff with a clean 400 `model_credential_missing`, BEFORE
  // the run row is created.
  describe("POST /api/agents/:scope/:name/run — missing model credential", () => {
    it("returns 400 model_credential_missing for a default model with an empty key", async () => {
      await seedAgent({
        id: "@runorg/nokey-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/nokey-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent used to exercise the empty-key kickoff guard",
        },
        draftContent: "Do the thing.",
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/nokey-agent",
      );

      // Credential with a blank secret — the service layer doesn't enforce a
      // min length (only the create-route Zod schema does), so this models a
      // stub/misconfigured key reaching resolution.
      const credentialId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: "Blank OpenAI",
        providerId: "openai",
        apiKey: "",
      });
      const modelDbId = await createOrgModel(
        ctx.orgId,
        "Blank GPT",
        "gpt-5.5",
        ctx.user.id,
        credentialId,
      );
      // First org model auto-defaults, but pin it explicitly so the test is
      // robust to that behavior changing.
      await setDefaultModel(ctx.orgId, modelDbId);

      const res = await app.request("/api/agents/@runorg/nokey-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string; detail?: string };
      expect(body.code).toBe("model_credential_missing");
      expect(body.detail).toContain("Blank GPT");

      // No run row should have been created — the guard fires before insert.
      const rows = await db.select().from(runs).where(eq(runs.packageId, "@runorg/nokey-agent"));
      expect(rows).toHaveLength(0);
    });
  });

  // ─── POST /api/agents/:scope/:name/run — resolved model echo ──
  //
  // #635: the trigger response echoes the resolved `model_label` +
  // `model_source` (snapshot of the values persisted on the run row) so
  // callers can detect org-default drift immediately — the org default is
  // resolved at run creation, not ahead of time, so a default changed
  // between triggers silently applies to the next run unless the caller
  // pins a model via the `modelId` body field.
  //
  // These are the only tests in this file that take the trigger to a 200 —
  // the fire-and-forget background execution runs against a fake
  // orchestrator (no Docker) so it settles in-process within the test,
  // instead of a slow real image pull racing the next test's truncateAll.
  describe("POST /api/agents/:scope/:name/run — resolved model echo", () => {
    /** Minimal no-op orchestrator: workloads "run" instantly and exit 0. */
    function createFakeOrchestrator(): RunOrchestrator {
      const handle = (runId: string, role: string): WorkloadHandle => ({
        id: `${role}_${runId}`,
        runId,
        role,
      });
      return {
        async initialize() {},
        async shutdown() {},
        async cleanupOrphans(): Promise<CleanupReport> {
          return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
        },
        async ensureImages() {},
        async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
          return {
            id: `net_${runId}`,
            name: `appstrate-exec-${runId}`,
            workspace: { kind: "directory", path: `/tmp/test-ws-${runId}` },
            sidecarEndpoints: {
              sidecarUrl: "http://sidecar:8080",
              llmProxyUrl: "http://sidecar:8080/llm",
              forwardProxyUrl: "http://sidecar:8081",
              noProxy: "sidecar,localhost,127.0.0.1",
            },
          };
        },
        async removeIsolationBoundary() {},
        async createSidecar(runId: string): Promise<WorkloadHandle> {
          return handle(runId, "sidecar");
        },
        async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
          return handle(spec.runId, spec.role);
        },
        async startWorkload() {},
        async stopWorkload() {},
        async removeWorkload() {},
        async waitForExit(): Promise<number> {
          return 0;
        },
        async *streamLogs(): AsyncGenerator<string> {},
        async stopByRunId(): Promise<StopResult> {
          return "stopped";
        },
        async resolvePlatformApiUrl(): Promise<string> {
          return "http://platform:3000";
        },
      };
    }

    beforeAll(() => {
      _setOrchestratorForTesting(createFakeOrchestrator());
    });

    afterAll(() => {
      _setOrchestratorForTesting(null);
    });
    async function seedRunnableAgent() {
      await seedAgent({
        id: "@runorg/echo-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@runorg/echo-agent",
          version: "0.1.0",
          type: "agent",
          description: "Agent used to exercise the resolved-model echo",
        },
        draftContent: "Do the thing.",
      });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/echo-agent",
      );
    }

    async function seedOrgModel(label: string): Promise<string> {
      const credentialId = await createApiKeyCredential({
        orgId: ctx.orgId,
        userId: ctx.user.id,
        label: `${label} credential`,
        providerId: "openai",
        apiKey: "sk-test-not-a-real-key",
      });
      return createOrgModel(ctx.orgId, label, "gpt-5.5", ctx.user.id, credentialId);
    }

    /**
     * The trigger is fire-and-forget: the fake-orchestrator workload exits 0
     * immediately and the platform synthesises a success terminal. Wait for
     * the in-flight tracker to drain, then give the post-untrack async tail
     * (`void emitEvent(...)`, event-buffer flush) a beat to finish, so the
     * background DB writes are contained within THIS test instead of racing
     * the next test's truncateAll.
     */
    async function waitForBackgroundSettled(): Promise<void> {
      await waitForInFlight(10_000);
      await Bun.sleep(300);
    }

    it("echoes the org default's model_label and model_source 'org'", async () => {
      await seedRunnableAgent();
      const modelDbId = await seedOrgModel("Echo Default GPT");
      await setDefaultModel(ctx.orgId, modelDbId);

      const res = await app.request("/api/agents/@runorg/echo-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id?: string;
        runId?: string;
        status?: string;
        agent_scope?: string | null;
        model_label?: string | null;
        model_source?: string | null;
      };
      // The trigger response is the bare Run DTO (same shape as GET /runs/:id).
      // The legacy `runId` alias was removed with the strict rule (#657).
      expect(body.id).toStartWith("run_");
      expect(body.runId).toBeUndefined();
      expect(body.status).toBeString();
      expect(body.agent_scope).toContain("runorg");
      expect(body.model_label).toBe("Echo Default GPT");
      expect(body.model_source).toBe("org");

      // The echo must match the persisted run-row snapshot — same source of truth.
      const [row] = await db.select().from(runs).where(eq(runs.id, body.id!));
      expect(row!.modelLabel).toBe("Echo Default GPT");
      expect(row!.modelSource).toBe("org");

      // The trigger leaves an audit trail (run.triggered, actor = the caller).
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "run.triggered"), eq(auditEvents.resourceId, body.id!)));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.orgId).toBe(ctx.orgId);
      expect(auditRows[0]!.resourceType).toBe("run");
      expect(auditRows[0]!.actorType).toBe("user");
      expect(auditRows[0]!.actorId).toBe(ctx.user.id);
      expect(auditRows[0]!.after).toMatchObject({
        packageId: "@runorg/echo-agent",
        origin: "platform",
      });

      await waitForBackgroundSettled();
    });

    it("echoes the pinned model when the body carries an explicit modelId", async () => {
      await seedRunnableAgent();
      const defaultId = await seedOrgModel("Echo Default GPT");
      await setDefaultModel(ctx.orgId, defaultId);
      const pinnedId = await seedOrgModel("Echo Pinned GPT");

      const res = await app.request("/api/agents/@runorg/echo-agent/run?version=draft", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, modelId: pinnedId }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        model_label?: string | null;
        model_source?: string | null;
      };
      expect(body.model_label).toBe("Echo Pinned GPT");
      expect(body.model_source).toBe("org");

      await waitForBackgroundSettled();
    });
  });

  // ─── GET /api/agents/:scope/:name/runs ─────────────────────

  describe("GET /api/agents/:scope/:name/runs", () => {
    it("returns empty array when no runs exist", async () => {
      await seedAgent({ id: "@runorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/my-agent",
      );

      const res = await app.request("/api/agents/@runorg/my-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toBeArray();
      expect(body.data).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns runs for an agent", async () => {
      await seedAgent({ id: "@runorg/my-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/my-agent",
      );
      const run = await seedRun({
        packageId: "@runorg/my-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request("/api/agents/@runorg/my-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      const found = body.data.find((e: { id: string }) => e.id === run.id);
      expect(found).toBeDefined();
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/secret-agent", orgId: otherCtx.orgId });
      await seedRun({
        packageId: "@otherorg/secret-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      // The agent does not belong to testorg, so requireAgent() should 404
      const res = await app.request("/api/agents/@otherorg/secret-agent/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@runorg/my-agent/runs");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/runs/:id ─────────────────────────────────────

  describe("GET /api/runs/:id", () => {
    it("returns run detail", async () => {
      await seedAgent({ id: "@runorg/detail-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/detail-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.id).toBe(run.id);
      expect(body.status).toBe("success");
    });

    it("returns 404 for non-existent run", async () => {
      const res = await app.request("/api/runs/exec_nonexistent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/other-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/other-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/runs/:id/logs ────────────────────────────────

  describe("GET /api/runs/:id/logs", () => {
    it("returns run logs", async () => {
      await seedAgent({ id: "@runorg/log-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/log-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "Step 1 completed",
        level: "info",
      });
      await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "Step 2 completed",
        level: "info",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
      expect(body.object).toBe("list");
      expect(body.data).toBeArray();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.hasMore).toBe(false);
    });

    it("returns an empty list envelope when no logs exist", async () => {
      await seedAgent({ id: "@runorg/nolog-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/nolog-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "pending",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(0);
      expect(body.hasMore).toBe(false);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/log-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/log-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything/logs");
      expect(res.status).toBe(401);
    });

    it("filters by ?since= cursor (returns only id > since)", async () => {
      await seedAgent({
        id: "@runorg/cursor-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const run = await seedRun({
        packageId: "@runorg/cursor-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      const log1 = await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "first",
        level: "info",
      });
      const log2 = await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "second",
        level: "info",
      });
      const log3 = await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "third",
        level: "info",
      });

      // since=log1.id → returns log2 and log3
      const res = await app.request(`/api/runs/${run.id}/logs?since=${log1.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: number; message: string }> };
      expect(body.data.map((l) => l.id)).toEqual([log2.id, log3.id]);
    });

    it("ignores a malformed ?since= cursor (returns full list)", async () => {
      await seedAgent({
        id: "@runorg/badcursor-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const run = await seedRun({
        packageId: "@runorg/badcursor-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "only",
        level: "info",
      });

      // Stale or garbled cursors must not 400 — the polling tail must
      // keep working through transient client-side malformation.
      const res = await app.request(`/api/runs/${run.id}/logs?since=not-a-number`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
    });

    it("?since=<highest_id> returns an empty array", async () => {
      await seedAgent({
        id: "@runorg/sinceall-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const run = await seedRun({
        packageId: "@runorg/sinceall-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      const log = await seedRunLog({
        runId: run.id,
        orgId: ctx.orgId,
        message: "only",
        level: "info",
      });

      const res = await app.request(`/api/runs/${run.id}/logs?since=${log.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });

    it("filters by ?level= minimum severity", async () => {
      await seedAgent({ id: "@runorg/level-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/level-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "boot", level: "debug" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "progress", level: "info" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "careful", level: "warn" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "boom", level: "error" });

      // level=info → info, warn, error (skips debug)
      const res = await app.request(`/api/runs/${run.id}/logs?level=info`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ level: string; message: string }> };
      expect(body.data.map((l) => l.level)).toEqual(["info", "warn", "error"]);

      // level=error → error only
      const resErr = await app.request(`/api/runs/${run.id}/logs?level=error`, {
        headers: authHeaders(ctx),
      });
      const bodyErr = (await resErr.json()) as { data: Array<{ level: string }> };
      expect(bodyErr.data.map((l) => l.level)).toEqual(["error"]);

      // level=debug → everything (explicit minimum == default)
      const resAll = await app.request(`/api/runs/${run.id}/logs?level=debug`, {
        headers: authHeaders(ctx),
      });
      const bodyAll = (await resAll.json()) as { data: unknown[] };
      expect(bodyAll.data).toHaveLength(4);
    });

    it("ignores an invalid ?level= value (returns full list)", async () => {
      await seedAgent({ id: "@runorg/badlevel-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/badlevel-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "a", level: "debug" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "b", level: "info" });

      const res = await app.request(`/api/runs/${run.id}/logs?level=loud`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(2);
    });

    it("paginates with ?limit= and emits a Link rel=next header re-using since", async () => {
      await seedAgent({ id: "@runorg/page-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/page-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      const log1 = await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "one" });
      const log2 = await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "two" });
      const log3 = await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "three" });

      const res = await app.request(`/api/runs/${run.id}/logs?limit=2`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: number }>; hasMore: boolean };
      expect(body.data.map((l) => l.id)).toEqual([log1.id, log2.id]);
      expect(body.hasMore).toBe(true);

      // Link header points at the next page, keyed on the last returned id.
      const link = res.headers.get("Link");
      expect(link).toContain(`since=${log2.id}`);
      expect(link).toContain('rel="next"');
      expect(link).toContain("limit=2");

      // Following the cursor returns the final page with no further Link.
      const res2 = await app.request(`/api/runs/${run.id}/logs?limit=2&since=${log2.id}`, {
        headers: authHeaders(ctx),
      });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { data: Array<{ id: number }>; hasMore: boolean };
      expect(body2.data.map((l) => l.id)).toEqual([log3.id]);
      expect(body2.hasMore).toBe(false);
      expect(res2.headers.get("Link")).toBeNull();
    });

    it("?limit= exactly matching the row count emits no Link header", async () => {
      await seedAgent({ id: "@runorg/exact-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/exact-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, message: "only" });

      const res = await app.request(`/api/runs/${run.id}/logs?limit=1`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
      expect(body.data).toHaveLength(1);
      expect(body.hasMore).toBe(false);
      expect(res.headers.get("Link")).toBeNull();
    });

    it("combines ?since=, ?level= and ?limit=", async () => {
      await seedAgent({ id: "@runorg/combo-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/combo-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      const first = await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "info" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "debug" });
      const kept1 = await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "warn" });
      const kept2 = await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "error" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "info" });

      const res = await app.request(
        `/api/runs/${run.id}/logs?since=${first.id}&level=info&limit=2`,
        { headers: authHeaders(ctx) },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: number }> };
      expect(body.data.map((l) => l.id)).toEqual([kept1.id, kept2.id]);
      const link = res.headers.get("Link");
      expect(link).toContain(`since=${kept2.id}`);
      expect(link).toContain("level=info");
      expect(link).toContain('rel="next"');
    });

    it("default behavior without new params is unchanged (full list, no Link)", async () => {
      await seedAgent({ id: "@runorg/compat-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/compat-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "debug" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "info" });
      await seedRunLog({ runId: run.id, orgId: ctx.orgId, level: "error" });

      const res = await app.request(`/api/runs/${run.id}/logs`, {
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { object: string; data: unknown[]; hasMore: boolean };
      expect(body.object).toBe("list");
      expect(body.data).toHaveLength(3);
      expect(body.hasMore).toBe(false);
      expect(res.headers.get("Link")).toBeNull();
    });

    describe("default ?limit= cap of 1000", () => {
      it("caps an unqualified GET at the oldest 1000 rows and pages on via the since cursor", async () => {
        await seedAgent({ id: "@runorg/cap-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
        const run = await seedRun({
          packageId: "@runorg/cap-agent",
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          status: "running",
        });

        // Bulk-insert 1001 rows in a single statement — serial ids are
        // assigned in VALUES order, so sorted ids mirror seeding order.
        const seeded = await db
          .insert(runLogs)
          .values(
            Array.from({ length: 1001 }, (_, i) => ({
              runId: run.id,
              orgId: ctx.orgId,
              type: "progress",
              level: "info" as const,
              message: `log ${i}`,
            })),
          )
          .returning({ id: runLogs.id });
        const ids = seeded.map((r) => r.id).sort((a, b) => a - b);
        const thousandthId = ids[999]!;
        const lastSeededId = ids[1000]!;

        // Page 1: no query params → exactly the OLDEST 1000 rows, ascending.
        const res = await app.request(`/api/runs/${run.id}/logs`, {
          headers: authHeaders(ctx),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: Array<{ id: number }>; hasMore: boolean };
        expect(body.data).toHaveLength(1000);
        expect(body.hasMore).toBe(true);
        expect(body.data[0]!.id).toBeLessThan(body.data.at(-1)!.id);
        expect(body.data[0]!.id).toBe(ids[0]!);
        expect(body.data.at(-1)!.id).toBe(thousandthId);

        const link = res.headers.get("Link");
        expect(link).not.toBeNull();
        expect(link).toContain(`since=${thousandthId}`);
        expect(link).toContain('rel="next"');

        // Page 2: follow the cursor → the single remaining row, no Link.
        const res2 = await app.request(`/api/runs/${run.id}/logs?since=${thousandthId}`, {
          headers: authHeaders(ctx),
        });
        expect(res2.status).toBe(200);
        const body2 = (await res2.json()) as { data: Array<{ id: number }>; hasMore: boolean };
        expect(body2.data.map((l) => l.id)).toEqual([lastSeededId]);
        expect(body2.hasMore).toBe(false);
        expect(res2.headers.get("Link")).toBeNull();
      });

      it("honours an explicit ?limit= and falls back to 1000 on a malformed one", async () => {
        await seedAgent({
          id: "@runorg/caplimit-agent",
          orgId: ctx.orgId,
          createdBy: ctx.user.id,
        });
        const run = await seedRun({
          packageId: "@runorg/caplimit-agent",
          orgId: ctx.orgId,
          applicationId: ctx.defaultAppId,
          userId: ctx.user.id,
          status: "running",
        });
        await db.insert(runLogs).values(
          Array.from({ length: 6 }, (_, i) => ({
            runId: run.id,
            orgId: ctx.orgId,
            type: "progress",
            level: "info" as const,
            message: `log ${i}`,
          })),
        );

        const res = await app.request(`/api/runs/${run.id}/logs?limit=5`, {
          headers: authHeaders(ctx),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
        expect(body.data).toHaveLength(5);
        expect(body.hasMore).toBe(true);

        // Lenient posture: a malformed limit falls back to the default
        // 1000 (returning everything here) instead of a 400.
        const resBad = await app.request(`/api/runs/${run.id}/logs?limit=abc`, {
          headers: authHeaders(ctx),
        });
        expect(resBad.status).toBe(200);
        const bodyBad = (await resBad.json()) as { data: unknown[]; hasMore: boolean };
        expect(bodyBad.data).toHaveLength(6);
        expect(bodyBad.hasMore).toBe(false);
      });
    });
  });

  // ─── POST /api/runs/:id/cancel ─────────────────────────────

  describe("POST /api/runs/:id/cancel", () => {
    it("cancels a running run and transitions it to cancelled", async () => {
      await seedAgent({ id: "@runorg/cancel-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/cancel-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
        // synthesiseFinalize requires sink_secret_encrypted to be present —
        // every real run created via run-pipeline gets one at INSERT time.
        sinkSecretEncrypted: "test-secret",
        sinkExpiresAt: new Date(Date.now() + 3600_000),
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      // The response is the bare updated Run resource (same shape as
      // GET /runs/:id), read after the terminal pipeline — not `{ok}` (#657).
      const body = (await res.json()) as { id?: string; ok?: unknown; status?: string };
      expect(body.ok).toBeUndefined();
      expect(body.id).toBe(run.id);
      expect(body.status).toBe("cancelled");

      // Convergence assertion — the cancel route flowed through finalizeRun
      // (status flipped to cancelled, sink closed). See `runs-cancel-
      // convergence.test.ts` for the afterRun-hook side of the contract.
      const final = await db
        .select({ status: runs.status, sinkClosedAt: runs.sinkClosedAt })
        .from(runs)
        .where(eq(runs.id, run.id));
      expect(final[0]!.status).toBe("cancelled");
      expect(final[0]!.sinkClosedAt).not.toBeNull();

      // The cancellation leaves an audit trail (run.cancelled, before/after status).
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "run.cancelled"), eq(auditEvents.resourceId, run.id)));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.orgId).toBe(ctx.orgId);
      expect(auditRows[0]!.resourceType).toBe("run");
      expect(auditRows[0]!.actorId).toBe(ctx.user.id);
      expect(auditRows[0]!.before).toMatchObject({ status: "running" });
      expect(auditRows[0]!.after).toMatchObject({ status: "cancelled" });
    });

    it("cancels a pending run and transitions it to cancelled", async () => {
      await seedAgent({ id: "@runorg/cancel-pending", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/cancel-pending",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "pending",
        sinkSecretEncrypted: "test-secret",
        sinkExpiresAt: new Date(Date.now() + 3600_000),
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { id?: string; status?: string };
      expect(body.id).toBe(run.id);
      expect(body.status).toBe("cancelled");

      const final = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, run.id));
      expect(final[0]!.status).toBe("cancelled");
    });

    it("returns 409 for non-running run", async () => {
      await seedAgent({ id: "@runorg/done-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/done-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent run", async () => {
      const res = await app.request("/api/runs/exec_nonexistent/cancel", {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for run from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedAgent({ id: "@otherorg/cancel-agent", orgId: otherCtx.orgId });
      const run = await seedRun({
        packageId: "@otherorg/cancel-agent",
        orgId: otherCtx.orgId,
        applicationId: otherCtx.defaultAppId,
        userId: otherCtx.user.id,
        status: "running",
        sinkSecretEncrypted: "test-secret",
        sinkExpiresAt: new Date(Date.now() + 3600_000),
      });

      const res = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/runs/exec_anything/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/agents/:scope/:name/runs ──────────────────

  describe("DELETE /api/agents/:scope/:name/runs", () => {
    it("deletes all runs for an agent (admin)", async () => {
      await seedAgent({ id: "@runorg/del-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/del-agent",
      );
      await seedRun({
        packageId: "@runorg/del-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedRun({
        packageId: "@runorg/del-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "failed",
      });

      const res = await app.request("/api/agents/@runorg/del-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deleted_count).toBeGreaterThanOrEqual(2);

      // The bulk delete leaves an audit trail (agent-scoped, with the count).
      const auditRows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, "agent.runs_bulk_deleted"),
            eq(auditEvents.resourceId, "@runorg/del-agent"),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.resourceType).toBe("agent");
      expect(auditRows[0]!.after).toMatchObject({ deletedCount: body.deleted_count });
    });

    it("returns 409 when running runs exist", async () => {
      await seedAgent({ id: "@runorg/running-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/running-agent",
      );
      await seedRun({
        packageId: "@runorg/running-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "running",
      });

      const res = await app.request("/api/agents/@runorg/running-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/agents/@runorg/any-agent/runs", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("only deletes runs in the current application (cross-app isolation)", async () => {
      // Create a second app
      const appB = await seedApplication({ orgId: ctx.orgId, name: "AppB" });

      await seedAgent({ id: "@runorg/iso-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/iso-agent",
      );
      await installPackage({ orgId: ctx.orgId, applicationId: appB.id }, "@runorg/iso-agent");

      // Seed runs in AppA
      await seedRun({
        packageId: "@runorg/iso-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      // Seed runs in AppB
      const appBRun = await seedRun({
        packageId: "@runorg/iso-agent",
        orgId: ctx.orgId,
        applicationId: appB.id,
        userId: ctx.user.id,
        status: "success",
      });

      // Delete from AppA context
      const res = await app.request("/api/agents/@runorg/iso-agent/runs", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.deleted_count).toBe(1);

      // AppB run should still exist
      const appBHeaders = {
        ...authHeaders(ctx),
        "X-Application-Id": appB.id,
      };
      const listRes = await app.request("/api/agents/@runorg/iso-agent/runs", {
        headers: appBHeaders,
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as any;
      const runIds = listBody.data.map((r: any) => r.id);
      expect(runIds).toContain(appBRun.id);
    });
  });

  // ─── Enriched run responses ─────────────────────────────────

  describe("Enriched run responses", () => {
    it("GET /api/runs/:id returns userName from profile", async () => {
      await seedAgent({ id: "@runorg/enriched-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/enriched-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.user_name).toBeString();
      expect(body.user_name).toBeTruthy();
      expect(body.end_user_name).toBeNull();
      expect(body.api_key_name).toBeNull();
      // scheduleName is populated from a LEFT JOIN on package_schedules — null
      // when the run has no scheduleId.
      expect(body.schedule_name).toBeNull();
    });

    it("GET /api/runs/:id projects resolvedConnections into connections_used (no raw connectionId)", async () => {
      await seedAgent({ id: "@runorg/conn-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/conn-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        resolvedConnections: {
          "@acme/gmail": {
            connectionId: "11111111-1111-1111-1111-111111111111",
            source: "member_pin",
            label: "Gmail Boulot",
            accountId: "dt@tractr.net",
          },
        },
      });

      const res = await app.request(`/api/runs/${run.id}`, { headers: authHeaders(ctx) });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connections_used).toEqual([
        {
          integration_id: "@acme/gmail",
          label: "Gmail Boulot",
          account_id: "dt@tractr.net",
          source: "member_pin",
        },
      ]);
      // The raw connection id is internal state and must not cross the wire.
      expect(JSON.stringify(body.connections_used)).not.toContain(
        "11111111-1111-1111-1111-111111111111",
      );
    });

    it("GET /api/runs/:id returns connections_used null when no integrations resolved", async () => {
      await seedAgent({ id: "@runorg/noconn-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const run = await seedRun({
        packageId: "@runorg/noconn-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, { headers: authHeaders(ctx) });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.connections_used).toBeNull();
    });

    it("GET /api/runs/:id preserves a text-only historical report result", async () => {
      await seedAgent({
        id: "@runorg/legacy-result-agent",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const run = await seedRun({
        packageId: "@runorg/legacy-result-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
        // Historical rows may contain only the deprecated report channel's
        // `text`/`text_truncated` keys with no structured `output`. They remain
        // readable for compatibility with existing agents and run history.
        result: { text: "legacy report body", text_truncated: false } as never,
      });

      const res = await app.request(`/api/runs/${run.id}`, { headers: authHeaders(ctx) });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.result).toEqual({ text: "legacy report body", text_truncated: false });
    });

    it("GET /api/runs/:id returns endUserName for end-user runs", async () => {
      await seedAgent({ id: "@runorg/eu-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "Alice External",
      });
      const run = await seedRun({
        packageId: "@runorg/eu-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        endUserId: eu.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.end_user_name).toBe("Alice External");
      expect(body.user_name).toBeNull();
    });

    it("GET /api/runs/:id returns endUserName from externalId fallback", async () => {
      await seedAgent({ id: "@runorg/eu2-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const eu = await seedEndUser({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        externalId: "ext-user-123",
      });
      const run = await seedRun({
        packageId: "@runorg/eu2-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        endUserId: eu.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.end_user_name).toBe("ext-user-123");
    });

    it("GET /api/runs/:id returns apiKeyName for API key runs", async () => {
      await seedAgent({ id: "@runorg/ak-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const apiKey = await seedApiKey({
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        name: "My Production Key",
      });
      const run = await seedRun({
        packageId: "@runorg/ak-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        apiKeyId: apiKey.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.api_key_name).toBe("My Production Key");
    });

    it("GET /api/runs/:id returns scheduleName for scheduled runs", async () => {
      await seedAgent({ id: "@runorg/sched-agent", orgId: ctx.orgId, createdBy: ctx.user.id });
      const schedule = await seedSchedule({
        packageId: "@runorg/sched-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        name: "Daily Sync",
      });
      const run = await seedRun({
        packageId: "@runorg/sched-agent",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        scheduleId: schedule.id,
        status: "success",
      });

      const res = await app.request(`/api/runs/${run.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.schedule_name).toBe("Daily Sync");
      expect(body.user_name).toBeNull();
    });

    it("GET /api/agents/:scope/:name/runs returns enriched fields in list", async () => {
      await seedAgent({ id: "@runorg/list-enriched", orgId: ctx.orgId, createdBy: ctx.user.id });
      await installPackage(
        { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        "@runorg/list-enriched",
      );
      await seedRun({
        packageId: "@runorg/list-enriched",
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request("/api/agents/@runorg/list-enriched/runs", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data).toHaveLength(1);
      expect(body.data[0].user_name).toBeString();
      expect(body.data[0].user_name).toBeTruthy();
      expect(body.data[0].end_user_name).toBeNull();
      expect(body.data[0].api_key_name).toBeNull();
      expect(body.data[0].schedule_name).toBeNull();
    });
  });
});
