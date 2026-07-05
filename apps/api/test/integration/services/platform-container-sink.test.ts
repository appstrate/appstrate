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
 *      {@link finalizeRun} call (status + sink_closed_at) when
 *      the container exits without calling finalize itself, covering
 *      crashes, timeouts, and defensive success-on-exit-0.
 *
 * Uses a fake `RunOrchestrator` so the tests exercise the real
 * lifecycle code without Docker. Every DB assertion hits the real
 * Postgres instance started by the test preload.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import type {
  RunOrchestrator,
  IsolationBoundary,
  SidecarLaunchSpec,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import {
  executeAgentInBackground,
  type ExecuteAgentInBackgroundInput,
} from "../../../src/services/run-launcher/execute-background.ts";
import { finalizeRun, getRunSinkContext } from "../../../src/services/run-event-ingestion.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
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
  orchestrator: RunOrchestrator;
  workloads: FakeWorkload[];
  boundaries: IsolationBoundary[];
  capturedAgentEnv: Record<string, string> | null;
}

function createFakeOrchestrator(config: FakeOrchestratorConfig = {}): FakeOrchestratorHandle {
  const handle: FakeOrchestratorHandle = {
    orchestrator: null as unknown as RunOrchestrator,
    workloads: [],
    boundaries: [],
    capturedAgentEnv: null,
  };

  const orchestrator: RunOrchestrator = {
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      const boundary: IsolationBoundary = {
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
      handle.boundaries.push(boundary);
      return boundary;
    },
    async removeIsolationBoundary() {},
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      _spec: SidecarLaunchSpec,
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

function buildTestBundle(): AppstrateRunPlan["bundle"] {
  const manifest = { name: "@test/agent", version: "1.0.0", type: "agent" };
  const files = new Map<string, Uint8Array>();
  files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  files.set("prompt.md", new TextEncoder().encode("Do the thing."));
  const identity = "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"];
  const packages: AppstrateRunPlan["bundle"]["packages"] = new Map();
  packages.set(identity, { identity, manifest, files, integrity: "sha256-stub" });
  return {
    bundleFormatVersion: "1.0",
    root: identity,
    packages,
    integrity: "sha256-stub",
  };
}

function buildRunPlan(): AppstrateRunPlan {
  return {
    bundle: buildTestBundle(),
    rawPrompt: "Do the thing.",
    llmConfig: {
      providerId: "anthropic",
      apiShape: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-3-5-sonnet-latest",
      apiKey: "sk-test-secret",
      label: "Test Model",
      isSystemModel: false,
      aliased: false,
      aliasId: "claude-3-5-sonnet-latest",
    },
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
  } as unknown as LoadedPackage;
}

async function seedRunWithSink(input: {
  ctx: TestContext;
  packageId: string;
  secret: string;
  expiresAt: Date;
}): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
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

  it("reports timedOut=true when the run exceeds its timeout window (safety net)", async () => {
    // 100ms budget, 500ms agent lifetime → the platform safety-net watchdog
    // must flip timedOut. `timeoutBootGraceMs: 0` exercises the net at the
    // budget itself (the fake orchestrator has no real runner to self-time-out,
    // so the net is the only timeout in play here).
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
      timeoutBootGraceMs: 0,
    });

    expect(result.timedOut).toBe(true);
  });

  it("the boot grace defers the safety net past the raw budget", async () => {
    // 50ms budget but a large grace → the net must NOT fire within the agent's
    // 200ms lifetime, so a clean exit-0 wins (timedOut stays false).
    const fake = createFakeOrchestrator({ exitCode: 0, exitDelayMs: 200 });
    const plan = buildRunPlan();
    plan.timeout = 0.05; // 50 ms budget

    const result = await runPlatformContainer({
      runId: "run_grace",
      context: buildContext("run_grace"),
      plan,
      sinkCredentials: mintSinkCredentials({
        runId: "run_grace",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator: fake.orchestrator,
      timeoutBootGraceMs: 5_000,
    });

    expect(result.timedOut).toBe(false);
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
    timeoutBootGraceMs?: number;
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
      finalize_url: `http://platform:3000/api/runs/${runId}/events/finalize`,
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
      ...(input.timeoutBootGraceMs !== undefined
        ? { timeoutBootGraceMs: input.timeoutBootGraceMs }
        : {}),
    };

    await executeAgentInBackground(execInput);
    return { runId, packageId: pkg.id };
  }

  it("writes a platform 'containers starting' progress run_log after the pending→running flip", async () => {
    const { runId } = await runWithFakeOrchestrator({ exitCode: 137 });
    // The breadcrumb is fire-and-forget inside executeAgentInBackground, so it
    // may land just after the function resolves — poll briefly for it.
    let row: typeof runLogs.$inferSelect | undefined;
    for (let attempt = 0; attempt < 20 && !row; attempt++) {
      [row] = await db
        .select()
        .from(runLogs)
        .where(eq(runLogs.runId, runId))
        .then((rows) => rows.filter((r) => r.message === "containers starting"));
      if (!row) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(row).toBeTruthy();
    // Same type/event/level combo the container's own progress breadcrumbs use
    // (appstrate-event-sink.ts → appendRunLog(progress/progress)) so the run
    // page renders it as a normal progress line.
    expect(row!.type).toBe("progress");
    expect(row!.event).toBe("progress");
    expect(row!.level).toBe("info");
  });

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
    // 100ms budget, 500ms agent lifetime, zero boot grace → safety-net timeout
    // path (no real runner here to self-time-out).
    const { runId } = await runWithFakeOrchestrator({
      exitCode: 0,
      exitDelayMs: 500,
      timeoutSeconds: 0.1,
      timeoutBootGraceMs: 0,
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
    // `sink_closed_at IS NULL` inside finalizeRun must short-circuit.
    const sinkRun = await getRunSinkContext(runId);
    expect(sinkRun).not.toBeNull();
    await finalizeRun({
      run: sinkRun!,
      result: {
        memories: [],
        output: null,
        logs: [],
        status: "success",
      },
    });

    const [second] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(second!.sinkClosedAt?.getTime()).toBe(firstClosedAt?.getTime());
    expect(second!.status).toBe("failed"); // first write wins
  });
});
