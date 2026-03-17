import { describe, test, expect, mock, beforeEach } from "bun:test";
import type {
  ExecutionAdapter,
  ExecutionMessage,
  PromptContext,
} from "../../services/adapters/types.ts";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { LoadedFlow } from "../../types/index.ts";
import { packageVersionsStub } from "../../services/__tests__/_db-mock.ts";

// --- Mocks ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({
  db: {},
}));

const logs: { event: string; data: Record<string, unknown> | null }[] = [];
const updates: { id: string; updates: Record<string, unknown> }[] = [];

mock.module("../../services/state.ts", () => ({
  appendExecutionLog: mock(
    async (
      _executionId: string,
      _userId: string,
      _orgId: string,
      _type: string,
      event: string,
      _message: string | null,
      data: Record<string, unknown> | null,
    ) => {
      logs.push({ event, data });
      return logs.length;
    },
  ),
  updateExecution: mock(async (id: string, upd: Record<string, unknown>) => {
    updates.push({ id, updates: upd });
  }),
  getPackageConfig: mock(async () => ({})),
  getLastExecutionState: mock(async () => null),
  createExecution: mock(async () => {}),
  getAdminConnections: mock(async () => ({})),
  getRunningExecutionsForPackage: mock(async () => 0),
  getExecution: mock(async () => null),
  getExecutionFull: mock(async () => null),
  deletePackageExecutions: mock(async () => {}),
  listPackageExecutions: mock(async () => []),
  listExecutionLogs: mock(async () => []),
  addPackageMemories: mock(async () => {}),
}));

mock.module("../../services/connection-manager.ts", () => ({
  getConnectionStatus: mock(async () => ({ status: "connected" })),
  listUserConnections: mock(async () => []),
  hasCustomConnection: mock(async () => false),
  validateScopes: mock(() => ({ sufficient: true, granted: [], required: [], missing: [] })),
  getConnection: mock(async () => null),
}));

class ModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured for this organization");
    this.name = "ModelNotConfiguredError";
  }
}

mock.module("../../services/env-builder.ts", () => ({
  ModelNotConfiguredError,
  buildPromptContext: mock(() => makePromptContext()),
  buildExecutionApi: mock((id: string) => ({ url: "http://localhost:3000", token: id })),
  buildExecutionContext: mock(async () => ({
    promptContext: makePromptContext(),
    flowPackage: null,
    flowVersionId: null,
    proxyLabel: null,
    modelLabel: null,
  })),
}));

mock.module("../../services/package-versions.ts", () => ({
  ...packageVersionsStub,
  getLatestVersionId: mock(async () => null),
  getVersionDetail: mock(async () => null),
}));

mock.module("../../services/execution-tracker.ts", () => ({
  trackExecution: mock(() => new AbortController()),
  untrackExecution: mock(() => {}),
  abortExecution: mock(() => {}),
}));

mock.module("../../middleware/guards.ts", () => ({
  requireFlow: mock(() => mock()),
  requireAdmin: mock(() => mock()),
  requireMutableFlow: mock(() => mock()),
}));

mock.module("../../middleware/rate-limit.ts", () => ({
  rateLimit: mock(() => mock()),
}));

mock.module("../../services/orchestrator/index.ts", () => ({
  getOrchestrator: () => ({ stopByExecutionId: mock(async () => "stopped") }),
}));

// Track how many times the adapter's execute() is called
let adapterCallCount = 0;
let mockAdapter: ExecutionAdapter;

class MockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

mock.module("../../services/adapters/index.ts", () => ({
  getAdapter: () => mockAdapter,
  TimeoutError: MockTimeoutError,
  buildRetryPrompt: (_badResult: unknown, _errors: string[], _schema: unknown) =>
    "mock retry prompt",
}));

mock.module("../../services/package-storage.ts", () => ({
  getPackageZip: mock(async () => null),
}));

mock.module("../../services/file-storage.ts", () => ({
  sanitizeStorageKey: (name: string) => name,
}));

// Import after mocks are set up
const { executeFlowInBackground } = await import("../executions.ts");

// --- Helpers ---

function makePromptContext(): PromptContext {
  return {
    rawPrompt: "test prompt",
    tokens: {},
    config: {},
    previousState: null,
    input: {},
    schemas: {},
    providers: [],
    llmModel: "claude-sonnet-4-5-20250929",
    llmConfig: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      modelId: "claude-sonnet-4-5-20250929",
      apiKey: "sk-test-key",
    },
  };
}

function createMockAdapter(results: (Record<string, unknown> | "timeout")[]): ExecutionAdapter {
  adapterCallCount = 0;
  return {
    async *execute(): AsyncGenerator<ExecutionMessage> {
      const idx = adapterCallCount++;
      const value = results[idx] ?? results[results.length - 1];
      if (value === "timeout") {
        throw new MockTimeoutError("Execution timed out");
      }
      yield { type: "progress", message: "Working..." };
      yield { type: "result", data: value as Record<string, unknown> };
    },
  };
}

function makeFlow(overrides: {
  outputSchema?: JSONSchemaObject;
  outputRetries?: number;
  timeout?: number;
}): LoadedFlow {
  return {
    id: "test-flow",
    prompt: "test prompt",
    skills: [],
    tools: [],
    source: "system",
    manifest: {
      schemaVersion: "1.0",
      name: "test-flow",
      displayName: "Test Flow",
      description: "A test flow",
      author: "test",
      dependencies: { providers: {}, skills: {}, tools: {} },
      output: overrides.outputSchema ? { schema: overrides.outputSchema } : undefined,
      timeout: overrides.timeout ?? 300,
      "x-outputRetries": overrides.outputRetries,
    } as unknown as LoadedFlow["manifest"],
  };
}

const OUTPUT_SCHEMA: JSONSchemaObject = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Summary text" },
    count: { type: "number", description: "Item count" },
  },
  required: ["summary", "count"],
};

function findLogs(event: string) {
  return logs.filter((l) => l.event === event);
}

function lastUpdate() {
  return updates[updates.length - 1];
}

// --- Tests ---

beforeEach(() => {
  logs.length = 0;
  updates.length = 0;
  adapterCallCount = 0;
});

describe("executeFlowInBackground — retry loop", () => {
  test("no output schema → no retry, status success", async () => {
    const result = { summary: "done" };
    mockAdapter = createMockAdapter([result]);

    const flow = makeFlow({});
    await executeFlowInBackground("exec-1", "user-1", "org-1", flow, makePromptContext());

    expect(adapterCallCount).toBe(1);
    expect(findLogs("output_validation_retry")).toHaveLength(0);
    expect(lastUpdate()!.updates.status).toBe("success");
  });

  test("valid output on first attempt → no retry, status success", async () => {
    const result = { summary: "done", count: 5 };
    mockAdapter = createMockAdapter([result]);

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA });
    await executeFlowInBackground("exec-2", "user-1", "org-1", flow, makePromptContext());

    expect(adapterCallCount).toBe(1);
    expect(findLogs("output_validation_retry")).toHaveLength(0);
    expect(lastUpdate()!.updates.status).toBe("success");
    expect((lastUpdate()!.updates.result as Record<string, unknown>).count).toBe(5);
  });

  test("invalid then valid → 1 retry, status success", async () => {
    const badResult = { summary: "done" }; // missing count
    const goodResult = { summary: "done", count: 3 };
    mockAdapter = createMockAdapter([badResult, goodResult]);

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA });
    await executeFlowInBackground("exec-3", "user-1", "org-1", flow, makePromptContext());

    expect(adapterCallCount).toBe(2);
    expect(findLogs("output_validation_retry")).toHaveLength(1);
    expect(findLogs("output_validation")).toHaveLength(0); // no final validation error
    expect(lastUpdate()!.updates.status).toBe("success");
    expect((lastUpdate()!.updates.result as Record<string, unknown>).count).toBe(3);
  });

  test("all retries fail → status success with last result, validation error logged", async () => {
    const badResult = { summary: "done" }; // always missing count
    mockAdapter = createMockAdapter([badResult, badResult, badResult]);

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA, outputRetries: 2 });
    await executeFlowInBackground("exec-4", "user-1", "org-1", flow, makePromptContext());

    // 1 initial + 2 retries = 3 calls
    expect(adapterCallCount).toBe(3);
    expect(findLogs("output_validation_retry")).toHaveLength(2);
    // Final validation failure logged
    const finalValidation = findLogs("output_validation");
    expect(finalValidation).toHaveLength(1);
    expect(finalValidation[0]!.data!.valid).toBe(false);
    // Still succeeds (uses last result)
    expect(lastUpdate()!.updates.status).toBe("success");
  });

  test("outputRetries: 0 → no retry even if invalid", async () => {
    const badResult = { summary: "done" }; // missing count
    mockAdapter = createMockAdapter([badResult]);

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA, outputRetries: 0 });
    await executeFlowInBackground("exec-5", "user-1", "org-1", flow, makePromptContext());

    expect(adapterCallCount).toBe(1);
    expect(findLogs("output_validation_retry")).toHaveLength(0);
    // Validation failure logged
    expect(findLogs("output_validation")).toHaveLength(1);
    expect(lastUpdate()!.updates.status).toBe("success");
  });

  test("timeout during retry → breaks out, uses last result", async () => {
    const badResult = { summary: "done" }; // missing count
    mockAdapter = createMockAdapter([badResult, "timeout"]);

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA, outputRetries: 3 });
    await executeFlowInBackground("exec-6", "user-1", "org-1", flow, makePromptContext());

    // 1 initial + 1 retry that timed out = 2 calls
    expect(adapterCallCount).toBe(2);
    expect(findLogs("output_validation_retry")).toHaveLength(1);
    // Still succeeds with last result
    expect(lastUpdate()!.updates.status).toBe("success");
  });
});
