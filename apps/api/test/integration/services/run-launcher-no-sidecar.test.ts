// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the "no-sidecar" run path.
 *
 * When a run's plan declares no integrations AND uses a static API key
 * (not OAuth), the sidecar is no overhead — its sole jobs are
 * integration MCP multiplexing and OAuth-LLM passthrough. The launcher
 * must skip `createSidecar` entirely in that case.
 *
 * This complements `run-launcher-parallel-boot.test.ts` — that file
 * asserts the parallel-create contract WHEN the sidecar is needed.
 */

import { describe, it, expect, beforeEach } from "bun:test";
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
import { runPlatformContainer } from "../../../src/services/run-launcher/pi.ts";
import { mintSinkCredentials } from "../../../src/lib/mint-sink-credentials.ts";
import type { AppstrateRunPlan } from "../../../src/services/run-launcher/types.ts";
import type { ExecutionContext } from "@appstrate/afps-runtime/types";
import { defaultTestAgentResources } from "../../helpers/run-resources.ts";

interface CallCounts {
  createSidecarCalls: number;
  createWorkloadCalls: number;
  capturedAgentEnv: Record<string, string> | null;
  capturedAgentSpec: WorkloadSpec | null;
  capturedSidecarSpec: SidecarLaunchSpec | null;
}

function createCountingFake(): {
  orchestrator: RunOrchestrator;
  counts: CallCounts;
} {
  const counts: CallCounts = {
    createSidecarCalls: 0,
    createWorkloadCalls: 0,
    capturedAgentEnv: null,
    capturedAgentSpec: null,
    capturedSidecarSpec: null,
  };

  const orchestrator: RunOrchestrator = {
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
          sidecarUrl: "http://fake-sidecar.test:19080",
          llmProxyUrl: "http://fake-sidecar.test:19080/llm",
          forwardProxyUrl: "http://fake-sidecar.test:19081",
          noProxy: "fake-sidecar.test,localhost,127.0.0.1",
        },
      };
    },
    async removeIsolationBoundary() {},
    async createSidecar(
      runId: string,
      _boundary: IsolationBoundary,
      spec: SidecarLaunchSpec,
    ): Promise<WorkloadHandle> {
      counts.createSidecarCalls++;
      counts.capturedSidecarSpec = spec;
      return { id: `sidecar_${runId}`, runId, role: "sidecar" };
    },
    async createWorkload(spec: WorkloadSpec): Promise<WorkloadHandle> {
      counts.createWorkloadCalls++;
      counts.capturedAgentEnv = { ...spec.env };
      counts.capturedAgentSpec = spec;
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
    runToken: "test-run-token",
    llmConfig: {
      providerId: "anthropic",
      piProvider: "anthropic",
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
    resources: defaultTestAgentResources(),
    ...overrides,
  };
}

function buildContext(runId: string): ExecutionContext {
  return { runId, input: {}, memories: [] };
}

describe("run-launcher — sidecar skip decision", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("skips createSidecar when no integrations AND llm uses a static API key", async () => {
    const { orchestrator, counts } = createCountingFake();
    const resources: AppstrateRunPlan["resources"] = {
      requested: { memoryMb: 768, cpu: 1 },
      effective: { memoryMb: 768, cpu: 1 },
      memoryCapped: false,
      cpuCapped: false,
      workload: { memoryBytes: 805_306_368, nanoCpus: 1_000_000_000 },
    };
    const plan = buildRunPlan({ resources });

    await runPlatformContainer({
      runId: "run_no_sidecar",
      context: buildContext("run_no_sidecar"),
      plan, // no integrations + apiKey set, no credentialId
      sinkCredentials: mintSinkCredentials({
        runId: "run_no_sidecar",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(0);
    expect(counts.createWorkloadCalls).toBe(1);
    expect(counts.capturedAgentSpec?.resources).toBe(resources.workload);

    // The agent env must not advertise a sidecar URL nor a forward proxy
    // — both would point at a non-existent service. MODEL_BASE_URL, however,
    // MUST carry the model's own baseUrl on the no-sidecar path so the Pi
    // SDK talks to the correct upstream instead of falling back to the
    // api-shape's native default (api.openai.com). See #741.
    const env = counts.capturedAgentEnv ?? {};
    expect(env.SIDECAR_URL).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.MODEL_BASE_URL).toBe("https://api.anthropic.com");
    // The real API key must reach the container — there's no sidecar to
    // substitute the placeholder back to the real value.
    expect(env.MODEL_API_KEY).toBe("sk-test-secret");
  });

  // The sidecar looks Pi's record up by the backing's Pi provider key — here
  // one that differs from the Appstrate id (`moonshot`).
  it("hands the sidecar the backing's Pi provider key", async () => {
    const { orchestrator, counts } = createCountingFake();
    await runPlatformContainer({
      runId: "run_alias_provider",
      context: buildContext("run_alias_provider"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "moonshot",
          piProvider: "moonshotai",
          apiShape: "openai-completions",
          baseUrl: "https://api.moonshot.ai/v1",
          modelId: "kimi-k2.6",
          apiKey: "sk-real-secret",
          label: "Appstrate Kimi",
          isSystemModel: true,
          aliased: true,
          aliasId: "appstrate-kimi",
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_alias_provider",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });
    const llm = counts.capturedSidecarSpec?.llm;
    if (llm?.authMode !== "api_key") throw new Error(`expected api_key llm, got ${llm?.authMode}`);
    expect(llm.modelSwap?.backing?.providerId).toBe("moonshotai");
  });

  it("hands a non-aliased container the Pi provider key, not the Appstrate id", async () => {
    const { orchestrator, counts } = createCountingFake();
    await runPlatformContainer({
      runId: "run_pi_key",
      context: buildContext("run_pi_key"),
      plan: buildRunPlan({
        proxyUrl: "http://proxy.test:8080",
        llmConfig: {
          providerId: "moonshot",
          piProvider: "moonshotai",
          apiShape: "openai-completions",
          baseUrl: "https://api.moonshot.ai/v1",
          modelId: "kimi-k2.6",
          apiKey: "sk-real-secret",
          label: "Kimi",
          isSystemModel: false,
          aliased: false,
          aliasId: "kimi-k2.6",
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_pi_key",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });
    expect(counts.capturedAgentEnv?.MODEL_PROVIDER).toBe("moonshotai");
  });

  // A user-described gateway has no Pi record: nothing may invent a key for it,
  // or the container / sidecar would resolve some other vendor's dialect.
  it("hands a gateway (no Pi provider key) neither a MODEL_PROVIDER nor a backing key", async () => {
    const gateway = {
      providerId: "openai-compatible",
      piProvider: null,
      apiShape: "openai-completions",
      baseUrl: "https://gateway.example.test/v1",
      modelId: "vendor/some-model",
      apiKey: "sk-real-secret",
      label: "Gateway",
      isSystemModel: false,
    } as const;

    const direct = createCountingFake();
    await runPlatformContainer({
      runId: "run_gateway_direct",
      context: buildContext("run_gateway_direct"),
      plan: buildRunPlan({
        llmConfig: { ...gateway, aliased: false, aliasId: "vendor/some-model" },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_gateway_direct",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator: direct.orchestrator,
    });
    expect(direct.counts.capturedAgentEnv?.MODEL_ID).toBe("vendor/some-model");
    expect(direct.counts.capturedAgentEnv).not.toHaveProperty("MODEL_PROVIDER");

    const aliased = createCountingFake();
    await runPlatformContainer({
      runId: "run_gateway_alias",
      context: buildContext("run_gateway_alias"),
      plan: buildRunPlan({
        llmConfig: { ...gateway, aliased: true, aliasId: "appstrate-gateway" },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_gateway_alias",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator: aliased.orchestrator,
    });
    const llm = aliased.counts.capturedSidecarSpec?.llm;
    if (llm?.authMode !== "api_key") throw new Error(`expected api_key llm, got ${llm?.authMode}`);
    expect(llm.modelSwap?.backing).toEqual({ providerId: null, input: ["text"] });
    expect(aliased.counts.capturedAgentEnv).not.toHaveProperty("MODEL_PROVIDER");
  });

  // `reasoning: false` is a stated fact (the operator turned it off), not an
  // unknown: it must reach the sidecar rather than be dropped so Pi's record
  // silently turns reasoning back on.
  it("passes an explicit reasoning:false through to the alias backing", async () => {
    const { orchestrator, counts } = createCountingFake();
    await runPlatformContainer({
      runId: "run_alias_no_reasoning",
      context: buildContext("run_alias_no_reasoning"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "anthropic",
          piProvider: "anthropic",
          apiShape: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          modelId: "claude-sonnet-4-6",
          apiKey: "sk-real-secret",
          label: "Appstrate Fast",
          isSystemModel: true,
          aliased: true,
          aliasId: "appstrate-fast",
          reasoning: false,
          input: ["text", "image"],
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_alias_no_reasoning",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });
    const llm = counts.capturedSidecarSpec?.llm;
    if (llm?.authMode !== "api_key") throw new Error(`expected api_key llm, got ${llm?.authMode}`);
    expect(llm.modelSwap?.backing).toEqual({
      providerId: "anthropic",
      reasoning: false,
      input: ["text", "image"],
    });
  });

  it("forces the sidecar for a model alias and wires the swap + alias MODEL_ID (api-key, no integrations)", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_alias",
      context: buildContext("run_alias"),
      // Would normally skip the sidecar (api-key, no integrations, no proxy) —
      // but an alias MUST route through it for the model swap.
      plan: buildRunPlan({
        llmConfig: {
          providerId: "deepseek",
          piProvider: "deepseek",
          apiShape: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          modelId: "deepseek-chat", // the hidden backing
          apiKey: "sk-real-secret",
          label: "Appstrate Medium",
          isSystemModel: true,
          aliased: true,
          aliasId: "appstrate-medium",
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_alias",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    // Sidecar is NOT skipped despite api-key + no integrations + no proxy.
    expect(counts.createSidecarCalls).toBe(1);

    // The sidecar receives the alias→real swap descriptor.
    const llm = counts.capturedSidecarSpec?.llm;
    // Narrow the discriminated union (vend variant carries no modelSwap).
    if (llm?.authMode !== "api_key") throw new Error(`expected api_key llm, got ${llm?.authMode}`);
    expect(llm.modelSwap).toEqual({
      alias: "appstrate-medium",
      real: "deepseek-chat",
      // The container speaks the canonical dialect; the sidecar terminates it
      // and re-originates against the backing, which needs the backing catalog.
      clientApiShape: "pi-messages",
      backingApiShape: "openai-completions",
      // No `reasoning`: unknown stays unset so Pi's record decides.
      backing: { providerId: "deepseek", input: ["text"] },
    });

    // The container is handed the ALIAS as MODEL_ID; the real backing id and
    // the real endpoint never enter the agent env.
    const env = counts.capturedAgentEnv ?? {};
    expect(env.MODEL_ID).toBe("appstrate-medium");
    expect(env.MODEL_BASE_URL).toBe("http://fake-sidecar.test:19080/llm");
    expect(JSON.stringify(env)).not.toContain("deepseek-chat");
    expect(JSON.stringify(env)).not.toContain("api.deepseek.com");
  });

  it("masks the alias's identifying model metadata in the container env — but not in the sidecar's", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_alias_mask",
      context: buildContext("run_alias_mask"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "deepseek",
          piProvider: "deepseek",
          apiShape: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          modelId: "deepseek-chat",
          apiKey: "sk-real-secret",
          label: "Appstrate Medium",
          isSystemModel: true,
          aliased: true,
          aliasId: "appstrate-medium",
          // A real catalog pair: exact enough to look up, which is the point.
          contextWindow: 200_000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_alias_mask",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    const env = counts.capturedAgentEnv ?? {};
    // The published rate card identifies the vendor on its own, so the
    // container is told nothing about price. The ledger is unaffected — the
    // runner row's cost is computed server-side from `runs.model_cost`.
    expect(env).not.toHaveProperty("MODEL_COST");
    expect(JSON.stringify(env)).not.toContain("0.28");
    // The real limits — the container needs both numbers to size compaction,
    // and the exact `usage.input` count it reports out-tells them anyway.
    expect(env.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(env.MODEL_MAX_TOKENS).toBe("8192");
    // Modalities survive: dropping MODEL_INPUT silently disables image input.
    expect(env.MODEL_INPUT).toBe(JSON.stringify(["text", "image"]));

    // The SIDECAR is trusted and its token-budget guard protects against the
    // REAL upstream limit — feeding it rounded values would be a correctness
    // regression, not extra safety. Independent path: `applySpecToSidecarEnv`
    // reads the spec, not the container env.
    expect(counts.capturedSidecarSpec?.modelContextWindow).toBe(200_000);
    expect(counts.capturedSidecarSpec?.modelMaxTokens).toBe(8192);
  });

  it("leaves a NON-aliased run's model metadata untouched", async () => {
    // A BYOK model the org configured itself has nothing to hide — the org
    // already knows its own binding, so nothing about these runs may change.
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_byok_mask",
      context: buildContext("run_byok_mask"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "deepseek",
          piProvider: "deepseek",
          apiShape: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          modelId: "deepseek-chat",
          apiKey: "sk-real-secret",
          label: "DeepSeek Chat",
          isSystemModel: false,
          aliased: false,
          aliasId: "deepseek-chat",
          contextWindow: 200_000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_byok_mask",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    const env = counts.capturedAgentEnv ?? {};
    expect(env.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(env.MODEL_MAX_TOKENS).toBe("8192");
    expect(env.MODEL_COST).toBe(
      JSON.stringify({ input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 }),
    );
  });

  // Pi's record of the backing carries its dialect (adaptive thinking, native
  // levels): the descriptor names only the Pi key, the container nothing.
  it("hands the sidecar no dialect of its own for an adaptive Anthropic backing", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_adaptive_alias",
      context: buildContext("run_adaptive_alias"),
      plan: buildRunPlan({
        generationConfig: { reasoning_level: "max" },
        llmConfig: {
          providerId: "anthropic",
          piProvider: "anthropic",
          apiShape: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          modelId: "claude-sonnet-4-6",
          apiKey: "sk-real-secret",
          label: "Appstrate Adaptive",
          isSystemModel: true,
          aliased: true,
          aliasId: "appstrate-adaptive",
          reasoning: true,
        },
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_adaptive_alias",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    const llm = counts.capturedSidecarSpec?.llm;
    if (llm?.authMode !== "api_key") throw new Error(`expected api_key llm, got ${llm?.authMode}`);
    expect(llm.modelSwap).toEqual({
      alias: "appstrate-adaptive",
      real: "claude-sonnet-4-6",
      clientApiShape: "pi-messages",
      backingApiShape: "anthropic-messages",
      backing: { providerId: "anthropic", reasoning: true, input: ["text"] },
    });

    const env = counts.capturedAgentEnv ?? {};
    expect(env.MODEL_ID).toBe("appstrate-adaptive");
    expect(env).not.toHaveProperty("MODEL_PROVIDER");
    expect(JSON.stringify(env)).not.toContain("claude-sonnet-4-6");
  });

  it("creates the sidecar when the plan declares at least one integration", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_with_integrations",
      context: buildContext("run_with_integrations"),
      plan: buildRunPlan({
        integrations: [
          {
            integrationId: "@test/gmail-mcp",
            namespace: "gmail",
            sourceKind: "local",
            manifest: { name: "@test/gmail-mcp", version: "1.0.0" },
            spawnEnv: {},
            toolAllowlist: [],
          },
        ],
      }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_with_integrations",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(1);
    expect(counts.createWorkloadCalls).toBe(1);
    // With sidecar wired, the agent env must point at it.
    const env = counts.capturedAgentEnv ?? {};
    expect(env.SIDECAR_URL).toBe("http://fake-sidecar.test:19080");
  });

  it("creates the sidecar when a proxy is configured (even with api-key + no integrations)", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_proxy",
      context: buildContext("run_proxy"),
      // No integrations + static API key would normally skip the sidecar,
      // but a configured proxy forces it: the sidecar's forward proxy is
      // the only path that routes agent egress through the proxy. Skipping
      // it would silently drop the proxy and leak the host IP.
      plan: buildRunPlan({ proxyUrl: "http://proxy.local:8080" }),
      sinkCredentials: mintSinkCredentials({
        runId: "run_proxy",
        appUrl: "http://platform:3000",
        ttlSeconds: 60,
      }),
      orchestrator,
    });

    expect(counts.createSidecarCalls).toBe(1);
    expect(counts.createWorkloadCalls).toBe(1);
    // With the sidecar wired, the agent egresses through its forward proxy.
    const env = counts.capturedAgentEnv ?? {};
    expect(env.SIDECAR_URL).toBe("http://fake-sidecar.test:19080");
    expect(env.HTTP_PROXY).toBe("http://fake-sidecar.test:19081");
    expect(env.HTTPS_PROXY).toBe("http://fake-sidecar.test:19081");
  });

  it("skip path passes the real api key through (no placeholder substitution without a sidecar)", async () => {
    const { orchestrator, counts } = createCountingFake();

    await runPlatformContainer({
      runId: "run_real_key",
      context: buildContext("run_real_key"),
      plan: buildRunPlan({
        llmConfig: {
          providerId: "openai",
          piProvider: "openai",
          apiShape: "openai-completions",
          baseUrl: "https://api.openai.com",
          modelId: "gpt-4o",
          apiKey: "sk-real-secret-1234",
          label: "GPT-4o",
          isSystemModel: false,
          aliased: false,
          aliasId: "gpt-4o",
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
