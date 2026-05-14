// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that `runPlatformContainer` routes every API-key LLM config
 * through Portkey (mandatory since Phase 2.5, #437) and fails fast when
 * an unmapped `apiShape` would otherwise bypass the gateway.
 *
 * Uses a fake `ContainerOrchestrator` so the test exercises the real
 * config-build code path in `services/run-launcher/pi.ts` without
 * Docker. Mirrors the fake-orchestrator pattern in
 * `platform-container-sink.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { encrypt } from "@appstrate/connect";
import type {
  ContainerOrchestrator,
  IsolationBoundary,
  SidecarConfig,
  StopResult,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
} from "@appstrate/core/platform-types";
import { db } from "@appstrate/db/client";
import { runs } from "@appstrate/db/schema";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { setPortkeyRouter, type PortkeyRouter } from "../../../src/services/portkey-router.ts";
import { buildPortkeyRouting } from "../../../src/modules/portkey/config.ts";

/**
 * Restore the preload-baseline router (passthrough mock pointing at
 * `host.docker.internal:8787`). Tests that need a different router
 * install their own, then call this to put the baseline back so the
 * next test starts from a clean known state.
 *
 * Delegates to the production `buildPortkeyRouting()` so per-shape
 * path math stays in one place — no second per-shape table to drift.
 */
function installBaselineRouter(): void {
  setPortkeyRouter((model) => buildPortkeyRouting(model, "http://host.docker.internal:8787"));
}
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

interface CapturedHandle {
  orchestrator: ContainerOrchestrator;
  capturedSidecarConfig: SidecarConfig | null;
  capturedAgentEnv: Record<string, string> | null;
}

function createCapturingOrchestrator(): CapturedHandle {
  const handle: CapturedHandle = {
    orchestrator: null as unknown as ContainerOrchestrator,
    capturedSidecarConfig: null,
    capturedAgentEnv: null,
  };

  const orch: ContainerOrchestrator = {
    async initialize() {},
    async shutdown() {},
    async cleanupOrphans(): Promise<CleanupReport> {
      return { workloads: 0, isolationBoundaries: 0 };
    },
    async ensureImages() {},
    async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
      return { id: `net_${runId}`, name: `appstrate-exec-${runId}` };
    },
    async removeIsolationBoundary() {},
    async createSidecar(
      runId: string,
      _b: IsolationBoundary,
      sidecarConfig: SidecarConfig,
    ): Promise<WorkloadHandle> {
      handle.capturedSidecarConfig = sidecarConfig;
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      if (spec.role === "agent") handle.capturedAgentEnv = { ...spec.env };
      return { id: `agent_${spec.runId}`, runId: spec.runId, role: spec.role };
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

  handle.orchestrator = orch;
  return handle;
}

function buildPlan(): AppstrateRunPlan {
  return {
    bundle: {
      bundleFormatVersion: "1.0",
      root: "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"],
      packages: new Map([
        [
          "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"],
          {
            identity: "@test/agent@1.0.0" as AppstrateRunPlan["bundle"]["root"],
            manifest: { name: "@test/agent", version: "1.0.0", type: "agent" },
            files: new Map(),
            integrity: "sha256-stub",
          },
        ],
      ]),
      integrity: "sha256-stub",
    },
    rawPrompt: "Do the thing.",
    llmConfig: {
      providerId: "openai",
      apiShape: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-5.4",
      apiKey: "sk-real-key-12345",
      label: "Test Model",
      isSystemModel: false,
    },
    tokens: {},
    providers: [],
    timeout: 60,
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [], config: {} };
}

async function seedRun(ctx: TestContext): Promise<string> {
  const pkg = await seedPackage({ orgId: ctx.orgId });
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId: pkg.id,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "pending",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt("test-secret"),
    sinkExpiresAt: new Date(Date.now() + 3_600_000),
    startedAt: new Date(),
  });
  return runId;
}

describe("runPlatformContainer — Portkey routing integration", () => {
  beforeEach(async () => {
    await truncateAll();
    // Restore baseline before every test — `setPortkeyRouter(null)` is
    // never installed in this suite (would crash request-time code that
    // assumes a non-null router slot).
    installBaselineRouter();
  });

  afterEach(() => {
    installBaselineRouter();
  });

  it("fails fast when the router cannot route an api_key apiShape", async () => {
    // Router installed but rejects this model — Portkey is mandatory,
    // so unroutable shapes are a config bug and must surface a clear
    // error rather than silently bypassing the gateway.
    setPortkeyRouter(() => null);

    const ctx = await createTestContext({ orgSlug: "unroutable" });
    const runId = await seedRun(ctx);
    const fake = createCapturingOrchestrator();

    await expect(
      runPlatformContainer({
        runId,
        context: buildContext(runId),
        plan: buildPlan(),
        sinkCredentials: mintSinkCredentials({
          runId,
          appUrl: "http://platform:3000",
          ttlSeconds: 3600,
        }),
        orchestrator: fake.orchestrator,
      }),
    ).rejects.toThrow(/Portkey routing/i);

    // No sidecar config captured — we fail before any container is created.
    expect(fake.capturedSidecarConfig).toBeNull();
  });

  it("re-points sidecar baseUrl + injects portkeyConfig when a router is installed", async () => {
    const router: PortkeyRouter = () => ({
      baseUrl: "http://host.docker.internal:8787",
      portkeyConfig: JSON.stringify({ provider: "openai", api_key: "sk-real-key-12345" }),
    });
    setPortkeyRouter(router);

    const ctx = await createTestContext({ orgSlug: "with-portkey" });
    const runId = await seedRun(ctx);
    const fake = createCapturingOrchestrator();

    await runPlatformContainer({
      runId,
      context: buildContext(runId),
      plan: buildPlan(),
      sinkCredentials: mintSinkCredentials({
        runId,
        appUrl: "http://platform:3000",
        ttlSeconds: 3600,
      }),
      orchestrator: fake.orchestrator,
    });

    expect(fake.capturedSidecarConfig).not.toBeNull();
    const llm = fake.capturedSidecarConfig!.llm;
    expect(llm).toBeDefined();
    expect(llm!.authMode).toBe("api_key");
    if (llm!.authMode === "api_key") {
      expect(llm!.baseUrl).toBe("http://host.docker.internal:8787");
      expect(llm!.portkeyConfig).toBeDefined();
      const parsed = JSON.parse(llm!.portkeyConfig!);
      expect(parsed.provider).toBe("openai");
    }
    // Pi SDK internal retry MUST be off — Portkey owns retries.
    expect(fake.capturedAgentEnv!.MODEL_RETRY_ENABLED).toBe("false");
  });

  it("consults the router on every api_key plan (Portkey-mandatory)", async () => {
    let routerCalled = false;
    setPortkeyRouter((model) => {
      routerCalled = true;
      return {
        baseUrl: "http://host.docker.internal:8787",
        portkeyConfig: JSON.stringify({ provider: "openai", api_key: model.apiKey }),
      };
    });

    const ctx = await createTestContext({ orgSlug: "api-key-mandatory" });
    const runId = await seedRun(ctx);
    const fake = createCapturingOrchestrator();

    await runPlatformContainer({
      runId,
      context: buildContext(runId),
      plan: buildPlan(),
      sinkCredentials: mintSinkCredentials({
        runId,
        appUrl: "http://platform:3000",
        ttlSeconds: 3600,
      }),
      orchestrator: fake.orchestrator,
    });

    expect(routerCalled).toBe(true);
  });
});
