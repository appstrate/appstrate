// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the "no-sidecar" run path.
 *
 * When a run's plan declares an empty `providers[]` AND uses a static
 * API key (not OAuth), the sidecar is no overhead — its sole jobs are
 * credential injection (`provider_call`) and OAuth-LLM passthrough.
 * The launcher must skip `createSidecar` entirely in that case.
 *
 * This complements `run-launcher-parallel-boot.test.ts` — that file
 * asserts the parallel-create contract WHEN the sidecar is needed.
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

interface CallCounts {
  createSidecarCalls: number;
  createWorkloadCalls: number;
  capturedAgentEnv: Record<string, string> | null;
}

function createCountingFake(): {
  orchestrator: ContainerOrchestrator;
  counts: CallCounts;
} {
  const counts: CallCounts = {
    createSidecarCalls: 0,
    createWorkloadCalls: 0,
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
      return { id: `net_${runId}`, name: `appstrate-exec-${runId}` };
    },
    async removeIsolationBoundary() {},
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      _spec: SidecarLaunchSpec,
    ): Promise<WorkloadHandle> {
      counts.createSidecarCalls++;
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      counts.createWorkloadCalls++;
      counts.capturedAgentEnv = { ...spec.env };
      return { id: `agent_${spec.runId}`, runId: spec.runId, role: spec.role };
    },
    async startWorkload() {},
    async stopWorkload() {},
    async removeWorkload() {},
    async waitForExit(): Promise<number> {
      // Return immediately — we're testing the launch decision, not lifecycle.
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

  return { orchestrator, counts };
}

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

function buildRunPlan(overrides: Partial<AppstrateRunPlan> = {}): AppstrateRunPlan {
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
    ...overrides,
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [], config: {} };
}

describe("run-launcher — sidecar skip decision", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("skips createSidecar when providers[] is empty AND llm uses a static API key", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_no_sidecar",
      context: buildContext("run_no_sidecar"),
      plan: buildRunPlan(), // empty providers[] + apiKey set, no credentialId
      sinkCredentials: mintSinkCredentials({
        runId: "run_no_sidecar",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(0);
    expect(counts.createWorkloadCalls).toBe(1);

    // The agent env must not advertise a sidecar URL nor a forward proxy
    // — both would point at a non-existent service. MODEL_BASE_URL should
    // also be absent (Pi SDK falls back to the API's native default).
    const env = counts.capturedAgentEnv ?? {};
    expect(env.SIDECAR_URL).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.MODEL_BASE_URL).toBeUndefined();
    // The real API key must reach the container — there's no sidecar to
    // substitute the placeholder back to the real value.
    expect(env.MODEL_API_KEY).toBe("sk-test-secret");
  });

  it("creates the sidecar when the plan declares at least one provider", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_with_providers",
      context: buildContext("run_with_providers"),
      plan: buildRunPlan({
        providers: [
          {
            id: "gmail",
            name: "gmail",
            displayName: "Gmail",
            authMode: "oauth2",
          } as AppstrateRunPlan["providers"][number],
        ],
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_with_providers",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(1);
    expect(counts.createWorkloadCalls).toBe(1);
    // With sidecar wired, the agent env must point at it.
    const env = counts.capturedAgentEnv ?? {};
    expect(env.SIDECAR_URL).toBe("http://sidecar:8080");
  });

  it("skip path passes the real api key through (no placeholder substitution without a sidecar)", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_real_key",
      context: buildContext("run_real_key"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "openai",
          apiShape: "openai-completions",
          baseUrl: "https://api.openai.com",
          modelId: "gpt-4o",
          apiKey: "sk-real-secret-1234",
          label: "GPT-4o",
          isSystemModel: false,
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_real_key",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(0);
    const env = counts.capturedAgentEnv ?? {};
    // Real key reaches the agent — without the sidecar there is no
    // intermediary to translate the placeholder back to the real secret.
    expect(env.MODEL_API_KEY).toBe("sk-real-secret-1234");
  });
});
