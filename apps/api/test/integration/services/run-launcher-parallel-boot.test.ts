// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the #406 parallel-boot contract.
 *
 * Phase 2 of the issue removed the synchronous `/health` await from
 * `DockerOrchestrator.createSidecar` — the orchestrator now returns
 * once the sidecar container is created + started, and the agent's MCP
 * retry handshake absorbs the race against the sidecar's HTTP listener
 * coming up. These tests assert that contract at the run-launcher
 * level so a future refactor cannot accidentally re-introduce the
 * serialized "create sidecar → wait for /health → start agent"
 * sequence.
 *
 * No real Docker. The fake orchestrator simulates a SLOW `createSidecar`
 * (artificial 500ms delay, mimicking pre-#406's `/health` wait); the
 * fake `createWorkload` records its own resolution timestamp; the
 * Promise.all in `pi.ts` must let the agent container get created
 * before the sidecar finishes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type {
  ContainerOrchestrator,
  IsolationBoundary,
  SidecarLaunchSpec,
  WorkloadHandle,
  WorkloadSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { truncateAll } from "../../helpers/db.ts";
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";

// ---------------------------------------------------------------------------
// Fake orchestrator with timing observability
// ---------------------------------------------------------------------------

interface TimingFakeConfig {
  /** Simulated sidecar boot latency (mimicking pre-#406's health-wait). */
  sidecarCreateDelayMs: number;
  /** How long the agent container "lives" before exit. */
  agentLifetimeMs: number;
}

interface TimingObservations {
  sidecarCreateStartedAt: number | null;
  sidecarCreateResolvedAt: number | null;
  agentCreateResolvedAt: number | null;
  agentStartedAt: number | null;
}

function createTimingFake(config: TimingFakeConfig): {
  orchestrator: ContainerOrchestrator;
  obs: TimingObservations;
} {
  const obs: TimingObservations = {
    sidecarCreateStartedAt: null,
    sidecarCreateResolvedAt: null,
    agentCreateResolvedAt: null,
    agentStartedAt: null,
  };

  const orchestrator: ContainerOrchestrator = {
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
      _boundary: IsolationBoundary,
      _spec: SidecarLaunchSpec,
    ): Promise<WorkloadHandle> {
      obs.sidecarCreateStartedAt = Date.now();
      // Artificial delay simulates the pre-#406 health-wait. Post-#406,
      // pi.ts must still let createWorkload race in parallel — the
      // Promise.all is the contract, and `createWorkload` will resolve
      // long before this does.
      await new Promise((resolve) => setTimeout(resolve, config.sidecarCreateDelayMs));
      obs.sidecarCreateResolvedAt = Date.now();
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      obs.agentCreateResolvedAt = Date.now();
      return { id: `agent_${spec.runId}`, runId: spec.runId, role: spec.role };
    },
    async startWorkload(w: WorkloadHandle) {
      if (w.role === "agent") obs.agentStartedAt = Date.now();
    },
    async stopWorkload() {},
    async removeWorkload() {},
    async waitForExit(): Promise<number> {
      await new Promise((resolve) => setTimeout(resolve, config.agentLifetimeMs));
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

  return { orchestrator, obs };
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
    },
    tokens: {},
    providers: [],
    timeout: 60,
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [], config: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("#406 parallel-boot — pi.ts vs slow sidecar", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("creates the agent workload in parallel with sidecar creation (does not serialize)", async () => {
    // 200ms simulated sidecar boot — `createWorkload` should resolve
    // BEFORE `createSidecar` does, proving the Promise.all branch.
    const { orchestrator, obs } = createTimingFake({
      sidecarCreateDelayMs: 200,
      agentLifetimeMs: 10,
    });

    await runPlatformContainer({
      runId: "run_parallel",
      context: buildContext("run_parallel"),
      plan: buildRunPlan(),
      sinkCredentials: mintSinkCredentials({
        runId: "run_parallel",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(obs.sidecarCreateStartedAt).not.toBeNull();
    expect(obs.sidecarCreateResolvedAt).not.toBeNull();
    expect(obs.agentCreateResolvedAt).not.toBeNull();

    // The whole point: the agent container is created BEFORE the
    // slow sidecar finishes booting. (The agent's actual MCP handshake
    // is covered by the retry tests in mcp-transport.)
    expect(obs.agentCreateResolvedAt!).toBeLessThan(obs.sidecarCreateResolvedAt!);

    // Sanity: both creations were kicked off within the same tick,
    // which is the Promise.all in pi.ts. Allowing 50ms slack for
    // event-loop dispatch on slow CI hosts.
    expect(Math.abs(obs.agentCreateResolvedAt! - obs.sidecarCreateStartedAt!)).toBeLessThan(50);
  });

  it("starts the agent only after both creates resolve (Promise.all completion)", async () => {
    // Even with the parallel-boot, pi.ts must still wait for the
    // sidecar handle to exist before starting the agent — otherwise
    // the cleanup chain has no sidecarHandle to remove on failure.
    const { orchestrator, obs } = createTimingFake({
      sidecarCreateDelayMs: 150,
      agentLifetimeMs: 10,
    });

    await runPlatformContainer({
      runId: "run_order",
      context: buildContext("run_order"),
      plan: buildRunPlan(),
      sinkCredentials: mintSinkCredentials({
        runId: "run_order",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(obs.agentStartedAt).not.toBeNull();
    // Agent start MUST happen after both create steps resolve.
    expect(obs.agentStartedAt!).toBeGreaterThanOrEqual(obs.sidecarCreateResolvedAt!);
    expect(obs.agentStartedAt!).toBeGreaterThanOrEqual(obs.agentCreateResolvedAt!);
  });

  it("absorbs a slow sidecar boot — run still completes successfully", async () => {
    // 500ms sidecar boot, 20ms agent lifetime. Without the parallel
    // change this would block agent start for 500ms; with it, the run
    // completes within ~550ms (sidecar boot + agent lifetime, not the
    // sum of the two).
    const { orchestrator } = createTimingFake({
      sidecarCreateDelayMs: 500,
      agentLifetimeMs: 20,
    });

    const startedAt = Date.now();
    const result = await runPlatformContainer({
      runId: "run_slow_sidecar",
      context: buildContext("run_slow_sidecar"),
      plan: buildRunPlan(),
      sinkCredentials: mintSinkCredentials({
        runId: "run_slow_sidecar",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    // Slow-sidecar boot dominates the critical path; the agent
    // lifetime overlaps with it. Total elapsed should be close to
    // max(500ms, 20ms) + small overhead, NOT 500ms + 20ms + serial
    // /health round-trips. Generous upper bound to keep the test
    // resilient on slow CI.
    expect(elapsed).toBeLessThan(2_000);
  });
});
