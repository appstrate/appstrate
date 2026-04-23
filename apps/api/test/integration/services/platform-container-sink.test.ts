// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the platform-container unified-runner path.
 *
 * The platform container no longer parses stdout — it speaks the exact
 * same HMAC-signed event protocol as every other runner (CLI, GitHub
 * Action, third-party). These tests exercise two invariants:
 *
 *   1. `runPlatformContainer` injects `APPSTRATE_SINK_URL`,
 *      `APPSTRATE_SINK_FINALIZE_URL`, and `APPSTRATE_SINK_SECRET` into
 *      the agent container env — the wire protocol's entry point.
 *
 *   2. `executeAgentInBackground` synthesises a terminal
 *      {@link finalizeRemoteRun} call (status + sink_closed_at) when
 *      the container exits without calling finalize itself, covering
 *      crashes, timeouts, and defensive success-on-exit-0.
 *
 * Uses a fake `ContainerOrchestrator` so the tests exercise the real
 * lifecycle code without Docker. Every DB assertion hits the real
 * Postgres instance started by the test preload.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import type {
  ContainerOrchestrator,
  IsolationBoundary,
  SidecarConfig,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { runPlatformContainer } from "../../../src/services/adapters/pi.ts";
import {
  executeAgentInBackground,
  type ExecuteAgentInBackgroundInput,
} from "../../../src/routes/runs.ts";
import { finalizeRemoteRun, getRunSinkContext } from "../../../src/services/run-event-ingestion.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/adapters/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import type { LoadedPackage } from "../../../src/types/index.ts";

// ---------------------------------------------------------------------------
// Fake orchestrator
// ---------------------------------------------------------------------------

interface FakeOrchestratorConfig {
  exitCode?: number;
  exitDelayMs?: number;
  throwOnStart?: boolean;
}

interface FakeWorkload extends WorkloadHandle {
  id: string;
  runId: string;
  role: string;
  env: Record<string, string>;
  status: "created" | "running" | "stopped";
  exitCode: number;
}

interface FakeOrchestratorHandle {
  orchestrator: ContainerOrchestrator;
  workloads: FakeWorkload[];
  boundaries: IsolationBoundary[];
  capturedAgentEnv: Record<string, string> | null;
}

function createFakeOrchestrator(config: FakeOrchestratorConfig = {}): FakeOrchestratorHandle {
  const handle: FakeOrchestratorHandle = {
    orchestrator: null as unknown as ContainerOrchestrator,
    workloads: [],
    boundaries: [],
    capturedAgentEnv: null,
  };

  const orchestrator: ContainerOrchestrator = {
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      const boundary: IsolationBoundary = { id: `net_${runId}`, name: `appstrate-exec-${runId}` };
      handle.boundaries.push(boundary);
      return boundary;
    },
    async removeIsolationBoundary() {},
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      _sidecarConfig: SidecarConfig,
    ): Promise<WorkloadHandle> {
      const w: FakeWorkload = {
        id: `sidecar_${runId}`,
        runId,
        role: "sidecar",
        env: {},
        status: "created",
        exitCode: 0,
      };
      handle.workloads.push(w);
      return w;
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      const w: FakeWorkload = {
        id: `agent_${spec.runId}`,
        runId: spec.runId,
        role: spec.role,
        env: { ...spec.env },
        status: "created",
        exitCode: config.exitCode ?? 0,
      };
      handle.workloads.push(w);
      if (spec.role === "agent") handle.capturedAgentEnv = { ...spec.env };
      return w;
    },
    async startWorkload(w: WorkloadHandle) {
      if (config.throwOnStart) throw new Error("orchestrator boom");
      (w as FakeWorkload).status = "running";
    },
    async stopWorkload(w: WorkloadHandle) {
      (w as FakeWorkload).status = "stopped";
    },
    async removeWorkload() {},
    async waitForExit(w: WorkloadHandle): Promise<number> {
      if (config.exitDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, config.exitDelayMs));
      }
      (w as FakeWorkload).status = "stopped";
      return (w as FakeWorkload).exitCode;
    },
    async *streamLogs(): AsyncGenerator<string> {
      // No log streaming — the unified protocol doesn't parse stdout.
    },
    async stopByRunId(): Promise<StopResult> {
      return "stopped";
    },
    async resolvePlatformApiUrl(): Promise<string> {
      return "http://platform:3000";
    },
  };

  handle.orchestrator = orchestrator;
  return handle;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildRunPlan(): AppstrateRunPlan {
  return {
    rawPrompt: "Do the thing.",
    schemas: {},
    llmConfig: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-3-5-sonnet-latest",
      apiKey: "sk-test-secret",
    },
    tokens: {},
    providers: [],
    availableTools: [],
    availableSkills: [],
    toolDocs: [],
    timeout: 60,
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [], config: {} };
}

function buildAgent(id: string): LoadedPackage {
  return {
    id,
    type: "agent",
    source: "local",
    manifest: { name: id, version: "1.0.0", type: "agent" },
    prompt: "Do the thing.",
    skills: [],
    tools: [],
    providers: [],
  } as unknown as LoadedPackage;
}

async function seedRunWithSink(input: {
  ctx: TestContext;
  packageId: string;
  secret: string;
  expiresAt: Date;
}): Promise<string> {
  const runId = `exec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId: input.packageId,
    orgId: input.ctx.orgId,
    applicationId: input.ctx.defaultAppId,
    status: "pending",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(input.secret),
    sinkExpiresAt: input.expiresAt,
    startedAt: new Date(),
  });
  return runId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPlatformContainer — sink env-var injection", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("injects APPSTRATE_SINK_URL, APPSTRATE_SINK_FINALIZE_URL, APPSTRATE_SINK_SECRET into the agent container env", async () => {
    const fake = createFakeOrchestrator({ exitCode: 0 });
    const credentials = mintSinkCredentials({
      runId: "run_test",
      appUrl: "http://platform:3000",
      ttlSeconds: 3600,
    });

    const result = await runPlatformContainer({
      runId: "run_test",
      context: buildContext("run_test"),
      plan: buildRunPlan(),
      sinkCredentials: credentials,
      orchestrator: fake.orchestrator,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);

    const env = fake.capturedAgentEnv!;
    expect(env.APPSTRATE_SINK_URL).toBe("http://platform:3000/api/runs/run_test/events");
    expect(env.APPSTRATE_SINK_FINALIZE_URL).toBe(
      "http://platform:3000/api/runs/run_test/events/finalize",
    );
    expect(env.APPSTRATE_SINK_SECRET).toBe(credentials.secret);
  });

  it("reports timedOut=true when the run exceeds its timeout window", async () => {
    // 100ms timeout, 500ms agent lifetime → must flip to timedOut.
    const fake = createFakeOrchestrator({ exitCode: 0, exitDelayMs: 500 });
    const plan = buildRunPlan();
    plan.timeout = 0.1; // 100 ms

    const result = await runPlatformContainer({
      runId: "run_timeout",
      context: buildContext("run_timeout"),
      plan,
      sinkCredentials: mintSinkCredentials({
        runId: "run_timeout",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator: fake.orchestrator,
    });

    expect(result.timedOut).toBe(true);
  });

  it("reports cancelled=true when the AbortSignal fires before exit", async () => {
    const fake = createFakeOrchestrator({ exitCode: 137, exitDelayMs: 200 });
    const controller = new AbortController();
    // Abort shortly after start.
    setTimeout(() => controller.abort(), 50);

    const result = await runPlatformContainer({
      runId: "run_cancel",
      context: buildContext("run_cancel"),
      plan: buildRunPlan(),
      sinkCredentials: mintSinkCredentials({
        runId: "run_cancel",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator: fake.orchestrator,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
  });
});

describe("executeAgentInBackground — server-side finalize synthesis", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({
      email: `synth-${crypto.randomUUID()}@test.com`,
      orgSlug: `synth-${crypto.randomUUID().slice(0, 6)}`,
    });
  });

  async function runWithFakeOrchestrator(input: {
    exitCode: number;
    exitDelayMs?: number;
    timeoutSeconds?: number;
  }): Promise<{ runId: string; packageId: string }> {
    const pkg = await seedPackage({
      id: `@${ctx.orgId.slice(0, 6)}/agent-${crypto.randomUUID().slice(0, 6)}`,
      orgId: ctx.orgId,
    });
    const credentials = mintSinkCredentials({
      runId: "temp",
      appUrl: "http://platform:3000",
      ttlSeconds: 3600,
    });
    const runId = await seedRunWithSink({
      ctx,
      packageId: pkg.id,
      secret: credentials.secret,
      expiresAt: new Date(credentials.expiresAt),
    });
    // Re-mint against the real runId so sink URLs are consistent.
    const realCredentials = {
      ...credentials,
      url: `http://platform:3000/api/runs/${runId}/events`,
      finalizeUrl: `http://platform:3000/api/runs/${runId}/events/finalize`,
    };

    const plan = buildRunPlan();
    if (input.timeoutSeconds !== undefined) plan.timeout = input.timeoutSeconds;

    const fake = createFakeOrchestrator({
      exitCode: input.exitCode,
      exitDelayMs: input.exitDelayMs,
    });

    const execInput: ExecuteAgentInBackgroundInput = {
      runId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      agent: buildAgent(pkg.id),
      context: buildContext(runId),
      plan,
      sinkCredentials: realCredentials,
      orchestrator: fake.orchestrator,
    };

    await executeAgentInBackground(execInput);
    return { runId, packageId: pkg.id };
  }

  it("synthesises a success finalize when the container exits 0 without posting one itself", async () => {
    const { runId } = await runWithFakeOrchestrator({ exitCode: 0 });
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row!.status).toBe("failed"); // ← zero tokens = LLM unreachable override
    expect(row!.sinkClosedAt).toBeTruthy();
    expect(row!.error).toContain("LLM API");
  });

  it("synthesises a failed finalize when the container exits non-zero", async () => {
    const { runId } = await runWithFakeOrchestrator({ exitCode: 137 });
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row!.status).toBe("failed");
    expect(row!.sinkClosedAt).toBeTruthy();
    expect(row!.error).toContain("exited with code 137");
  });

  it("synthesises a timeout finalize when the run exceeds its timeout", async () => {
    // 100ms timeout, 500ms agent lifetime → timeout path.
    const { runId } = await runWithFakeOrchestrator({
      exitCode: 0,
      exitDelayMs: 500,
      timeoutSeconds: 0.1,
    });
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row!.status).toBe("timeout");
    expect(row!.sinkClosedAt).toBeTruthy();
    expect(row!.error).toContain("timed out");
  });

  it("finalize synthesis is idempotent — a late container finalize CASs out", async () => {
    const { runId } = await runWithFakeOrchestrator({ exitCode: 137 });
    const [first] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(first!.status).toBe("failed");
    const firstClosedAt = first!.sinkClosedAt;

    // Simulate the container posting a late finalize — the CAS on
    // `sink_closed_at IS NULL` inside finalizeRemoteRun must short-circuit.
    const sinkRun = await getRunSinkContext(runId);
    expect(sinkRun).not.toBeNull();
    await finalizeRemoteRun({
      run: sinkRun!,
      result: {
        memories: [],
        state: null,
        output: null,
        report: null,
        logs: [],
        status: "success",
      },
      webhookId: `late-${runId}`,
    });

    const [second] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(second!.sinkClosedAt?.getTime()).toBe(firstClosedAt?.getTime());
    expect(second!.status).toBe("failed"); // first write wins
  });
});
