// SPDX-License-Identifier: Apache-2.0

/**
 * PiAdapter.execute() unit tests.
 *
 * Uses a mock ContainerOrchestrator injected via constructor DI to test
 * the full run pipeline without Docker.
 */
import { describe, it, expect, mock } from "bun:test";
import { PiAdapter } from "../../src/services/adapters/pi.ts";
import type { ContainerOrchestrator } from "../../src/services/orchestrator/interface.ts";
import type {
  WorkloadHandle,
  IsolationBoundary,
  WorkloadSpec,
  SidecarConfig,
} from "../../src/services/orchestrator/types.ts";
import type { RunMessage, PromptContext } from "../../src/services/adapters/types.ts";

// ─── Helpers ────────────────────────────────────────────────

function createMockOrchestrator(overrides?: Partial<ContainerOrchestrator>): ContainerOrchestrator {
  return {
    initialize: mock(() => Promise.resolve()),
    shutdown: mock(() => Promise.resolve()),
    cleanupOrphans: mock(() => Promise.resolve({ workloads: 0, isolationBoundaries: 0 })),
    ensureImages: mock(() => Promise.resolve()),
    createIsolationBoundary: mock(
      (runId: string): Promise<IsolationBoundary> =>
        Promise.resolve({ id: `net-${runId}`, name: `appstrate-exec-${runId}` }),
    ),
    removeIsolationBoundary: mock(() => Promise.resolve()),
    createSidecar: mock(
      (
        _runId: string,
        _boundary: IsolationBoundary,
        _config: SidecarConfig,
      ): Promise<WorkloadHandle> =>
        Promise.resolve({ id: "sidecar-001", runId: _runId, role: "sidecar" }),
    ),
    createWorkload: mock(
      (spec: WorkloadSpec, _boundary: IsolationBoundary): Promise<WorkloadHandle> =>
        Promise.resolve({ id: "agent-001", runId: spec.runId, role: "agent" }),
    ),
    startWorkload: mock(() => Promise.resolve()),
    stopWorkload: mock(() => Promise.resolve()),
    removeWorkload: mock(() => Promise.resolve()),
    waitForExit: mock(() => Promise.resolve(0)),
    streamLogs: mock(async function* () {
      yield JSON.stringify({ type: "text_delta", text: "Working..." });
      yield JSON.stringify({ type: "output", data: { result: "Done" } });
    }),
    stopByRunId: mock(() => Promise.resolve("stopped" as const)),
    ...overrides,
  };
}

function basePromptContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    rawPrompt: "Do the task.",
    tokens: {},
    config: {},
    previousState: null,
    input: {},
    schemas: {},
    providers: [],
    llmModel: "claude-sonnet",
    llmConfig: {
      api: "anthropic",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-20250514",
      apiKey: "sk-ant-api03-test",
    },
    ...overrides,
  };
}

async function collectMessages(gen: AsyncGenerator<RunMessage>): Promise<RunMessage[]> {
  const messages: RunMessage[] = [];
  for await (const msg of gen) messages.push(msg);
  return messages;
}

// ─── Tests ──────────────────────────────────────────────────

describe("PiAdapter.execute()", () => {
  it("runs the full pipeline: boundary → sidecar + agent → lifecycle → cleanup", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const messages = await collectMessages(adapter.execute("exec-001", basePromptContext(), 30));

    // Phase 1: isolation boundary created
    expect(orchestrator.createIsolationBoundary).toHaveBeenCalledWith("exec-001");

    // Phase 2: sidecar and agent created in parallel
    expect(orchestrator.createSidecar).toHaveBeenCalledTimes(1);
    expect(orchestrator.createWorkload).toHaveBeenCalledTimes(1);

    // Phase 3: agent started, logs streamed, waited for exit
    expect(orchestrator.startWorkload).toHaveBeenCalledTimes(1);
    expect(orchestrator.waitForExit).toHaveBeenCalledTimes(1);

    // Cleanup: sidecar + boundary removed
    expect(orchestrator.removeWorkload).toHaveBeenCalledTimes(2); // agent + sidecar
    expect(orchestrator.removeIsolationBoundary).toHaveBeenCalledTimes(1);

    // Verify messages: "container started" + streamed log messages
    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toContain("container started");

    const output = messages.find((m) => m.type === "output");
    expect(output).toBeDefined();
    expect(output!.data).toEqual({ result: "Done" });
  });

  it("passes LLM proxy config to sidecar when API key provided", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    await collectMessages(adapter.execute("exec-002", basePromptContext(), 30));

    const sidecarCall = (orchestrator.createSidecar as ReturnType<typeof mock>).mock.calls[0]!;
    const config = sidecarCall[2] as SidecarConfig;
    expect(config.llm).toBeDefined();
    expect(config.llm!.baseUrl).toBe("https://api.anthropic.com");
    expect(config.llm!.placeholder).toBe("sk-ant-api03-placeholder");
    // Real key is passed to sidecar, NOT to agent
    expect(config.llm!.apiKey).toBe("sk-ant-api03-test");
  });

  it("sets agent env vars correctly (proxy routing, model config)", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    await collectMessages(adapter.execute("exec-003", basePromptContext(), 30));

    const workloadCall = (orchestrator.createWorkload as ReturnType<typeof mock>).mock.calls[0]!;
    const spec = workloadCall[0] as WorkloadSpec;

    // Agent uses sidecar for LLM, NOT real API
    expect(spec.env.MODEL_BASE_URL).toBe("http://sidecar:8080/llm");
    expect(spec.env.MODEL_API_KEY).toBe("sk-ant-api03-placeholder");
    expect(spec.env.MODEL_API).toBe("anthropic");
    expect(spec.env.MODEL_ID).toBe("claude-sonnet-4-20250514");

    // HTTP proxy for network isolation
    expect(spec.env.HTTP_PROXY).toBe("http://sidecar:8081");
    expect(spec.env.HTTPS_PROXY).toBe("http://sidecar:8081");
    expect(spec.env.NO_PROXY).toBe("sidecar,localhost,127.0.0.1");
  });

  it("does not set LLM proxy when no API key", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({
      llmConfig: {
        api: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelId: "test-model",
        apiKey: "",
      },
    });

    await collectMessages(adapter.execute("exec-004", ctx, 30));

    const sidecarCall = (orchestrator.createSidecar as ReturnType<typeof mock>).mock.calls[0]!;
    const config = sidecarCall[2] as SidecarConfig;
    expect(config.llm).toBeUndefined();

    const workloadCall = (orchestrator.createWorkload as ReturnType<typeof mock>).mock.calls[0]!;
    const spec = workloadCall[0] as WorkloadSpec;
    expect(spec.env.MODEL_BASE_URL).toBeUndefined();
    expect(spec.env.MODEL_API_KEY).toBeUndefined();
  });

  it("injects agent package and input files into agent workload", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const agentPackage = Buffer.from("fake-zip-content");
    const inputFiles = [
      {
        fieldName: "doc",
        name: "report.pdf",
        type: "application/pdf",
        size: 1024,
        buffer: Buffer.from("pdf"),
      },
    ];

    await collectMessages(
      adapter.execute("exec-005", basePromptContext(), 30, agentPackage, undefined, inputFiles),
    );

    const workloadCall = (orchestrator.createWorkload as ReturnType<typeof mock>).mock.calls[0]!;
    const spec = workloadCall[0] as WorkloadSpec;

    expect(spec.files).toBeDefined();
    expect(spec.files!.targetDir).toBe("/workspace");
    expect(spec.files!.items).toHaveLength(2);
    expect(spec.files!.items[0]!.name).toBe("agent-package.afps");
    expect(spec.files!.items[1]!.name).toBe("documents/report.pdf");
  });

  it("sets CONNECTED_PROVIDERS when providers have tokens", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({
      tokens: { "@test/gmail": "tok1", "@test/stripe": "tok2" },
      providers: [
        { id: "@test/gmail", displayName: "Gmail", authMode: "oauth2" },
        { id: "@test/stripe", displayName: "Stripe", authMode: "api_key" },
        { id: "@test/unconnected", displayName: "NC", authMode: "oauth2" },
      ],
    });

    await collectMessages(adapter.execute("exec-006", ctx, 30));

    const workloadCall = (orchestrator.createWorkload as ReturnType<typeof mock>).mock.calls[0]!;
    const spec = workloadCall[0] as WorkloadSpec;
    expect(spec.env.CONNECTED_PROVIDERS).toBe("@test/gmail,@test/stripe");
  });

  it("injects OUTPUT_SCHEMA when output schema present", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const outputSchema = {
      type: "object",
      properties: {
        total: { type: "number", description: "Total count" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["total", "items"],
    };

    const ctx = basePromptContext({
      schemas: { output: outputSchema as any },
    });

    await collectMessages(adapter.execute("exec-schema", ctx, 30));

    const spec = (orchestrator.createWorkload as ReturnType<typeof mock>).mock
      .calls[0]![0] as WorkloadSpec;
    expect(spec.env.OUTPUT_SCHEMA).toBeDefined();
    const parsed = JSON.parse(spec.env.OUTPUT_SCHEMA!);
    expect(parsed.properties.total.type).toBe("number");
    expect(parsed.required).toEqual(["total", "items"]);
  });

  it("does not inject OUTPUT_SCHEMA when no output schema", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({ schemas: {} });

    await collectMessages(adapter.execute("exec-no-schema", ctx, 30));

    const spec = (orchestrator.createWorkload as ReturnType<typeof mock>).mock
      .calls[0]![0] as WorkloadSpec;
    expect(spec.env.OUTPUT_SCHEMA).toBeUndefined();
  });

  it("cleans up sidecar and boundary even on error", async () => {
    const orchestrator = createMockOrchestrator({
      startWorkload: mock(() => Promise.reject(new Error("start failed"))),
    });
    const adapter = new PiAdapter(orchestrator);

    try {
      await collectMessages(adapter.execute("exec-009", basePromptContext(), 30));
      expect.unreachable("should have thrown");
    } catch {
      // Expected
    }

    // Sidecar removed
    const removeWlCalls = (orchestrator.removeWorkload as ReturnType<typeof mock>).mock.calls;
    const removedRoles = removeWlCalls.map((c: any[]) => (c[0] as WorkloadHandle).role);
    expect(removedRoles).toContain("sidecar");

    // Boundary removed
    expect(orchestrator.removeIsolationBoundary).toHaveBeenCalledTimes(1);
  });

  it("passes proxy URL to sidecar config", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({ proxyUrl: "http://proxy.corp:8080" });

    await collectMessages(adapter.execute("exec-010", ctx, 30));

    const config = (orchestrator.createSidecar as ReturnType<typeof mock>).mock
      .calls[0]![2] as SidecarConfig;
    expect(config.proxyUrl).toBe("http://proxy.corp:8080");
  });

  it("sets MODEL_COST when cost config provided", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({
      llmConfig: {
        api: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-sonnet-4-20250514",
        apiKey: "sk-test",
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    });

    await collectMessages(adapter.execute("exec-011", ctx, 30));

    const spec = (orchestrator.createWorkload as ReturnType<typeof mock>).mock
      .calls[0]![0] as WorkloadSpec;
    const cost = JSON.parse(spec.env.MODEL_COST!);
    expect(cost.input).toBe(3);
    expect(cost.output).toBe(15);
  });

  it("sets model capability env vars when provided", async () => {
    const orchestrator = createMockOrchestrator();
    const adapter = new PiAdapter(orchestrator);

    const ctx = basePromptContext({
      llmConfig: {
        api: "anthropic",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-sonnet-4-20250514",
        apiKey: "sk-test",
        input: ["text", "image"],
        contextWindow: 200000,
        maxTokens: 16384,
        reasoning: true,
      },
    });

    await collectMessages(adapter.execute("exec-012", ctx, 30));

    const spec = (orchestrator.createWorkload as ReturnType<typeof mock>).mock
      .calls[0]![0] as WorkloadSpec;
    expect(spec.env.MODEL_INPUT).toBe('["text","image"]');
    expect(spec.env.MODEL_CONTEXT_WINDOW).toBe("200000");
    expect(spec.env.MODEL_MAX_TOKENS).toBe("16384");
    expect(spec.env.MODEL_REASONING).toBe("true");
  });
});
