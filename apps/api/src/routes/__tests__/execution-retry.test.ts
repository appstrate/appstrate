import { describe, test, expect, mock, beforeEach } from "bun:test";
import type {
  ExecutionAdapter,
  ExecutionMessage,
  PromptContext,
} from "../../services/adapters/types.ts";
import type { JSONSchemaObject } from "@appstrate/shared-types";
import type { LoadedFlow } from "../../types/index.ts";
import type { Actor } from "../../lib/actor.ts";
import { packageVersionsStub, schemaStubs } from "../../services/__tests__/_db-mock.ts";

// --- Mocks ---

const testActor: Actor = { type: "member", id: "user-1" };
const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({
  db: {},
}));

mock.module("@appstrate/db/schema", () => schemaStubs);

const logs: { event: string; data: Record<string, unknown> | null }[] = [];
const updates: { id: string; updates: Record<string, unknown> }[] = [];

mock.module("../../services/state/index.ts", () => ({
  appendExecutionLog: mock(
    async (
      _executionId: string,
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
  getRunningExecutionCountForOrg: mock(async () => 0),
  getExecution: mock(async () => null),
  getExecutionFull: mock(async () => null),
  deletePackageExecutions: mock(async () => {}),
  listPackageExecutions: mock(async () => []),
  listExecutionLogs: mock(async () => []),
  addPackageMemories: mock(async () => {}),
}));

mock.module("../../services/connection-manager/index.ts", () => ({
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
    packageVersionId: null,
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
  getInFlightCount: mock(() => 0),
  waitForInFlight: mock(async () => true),
  initCancelSubscriber: mock(() => {}),
  stopCancelSubscriber: mock(async () => {}),
}));

mock.module("../../middleware/guards.ts", () => ({
  requireFlow: mock(() => mock()),
  requireAdmin: mock(() => mock()),
  requireMutableFlow: mock(() => mock()),
  checkScopeMatch: mock(() => null),
}));

mock.module("../../middleware/rate-limit.ts", () => ({
  rateLimit: mock(() => mock()),
}));

mock.module("../../services/orchestrator/index.ts", () => ({
  getOrchestrator: () => ({ stopByExecutionId: mock(async () => "stopped") }),
}));

let adapterMessages: ExecutionMessage[] = [];

class MockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

mock.module("../../services/adapters/index.ts", () => ({
  getAdapter: (): ExecutionAdapter => ({
    async *execute(): AsyncGenerator<ExecutionMessage> {
      for (const msg of adapterMessages) {
        yield msg;
      }
    },
  }),
  TimeoutError: MockTimeoutError,
}));

mock.module("../../services/package-storage.ts", () => ({
  getPackageZip: mock(async () => null),
}));

mock.module("../../services/file-storage.ts", () => ({
  sanitizeStorageKey: (name: string) => name,
}));

mock.module("../../lib/cloud-loader.ts", () => ({
  getCloudModule: () => null,
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

function makeFlow(overrides?: { outputSchema?: JSONSchemaObject }): LoadedFlow {
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
      output: overrides?.outputSchema ? { schema: overrides.outputSchema } : undefined,
      timeout: 300,
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
  adapterMessages = [];
});

describe("executeFlowInBackground — output tools", () => {
  test("structured_output → success with data", async () => {
    adapterMessages = [
      { type: "progress", message: "Working..." },
      { type: "structured_output", data: { summary: "done", count: 5 } },
    ];

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA });
    await executeFlowInBackground("exec-1", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("success");
    const result = lastUpdate()!.updates.result as { data: Record<string, unknown> };
    expect(result.data.summary).toBe("done");
    expect(result.data.count).toBe(5);
  });

  test("report → success with report", async () => {
    adapterMessages = [
      { type: "progress", message: "Analyzing..." },
      { type: "report", content: "## Summary\n\nAll good." },
    ];

    const flow = makeFlow({});
    await executeFlowInBackground("exec-2", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("success");
    const result = lastUpdate()!.updates.result as { report: string };
    expect(result.report).toBe("## Summary\n\nAll good.\n\n");
  });

  test("report + structured_output → success with both", async () => {
    adapterMessages = [
      { type: "report", content: "## Report\n\n" },
      { type: "report", content: "Details here." },
      { type: "structured_output", data: { count: 42 } },
    ];

    const flow = makeFlow({});
    await executeFlowInBackground("exec-3", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("success");
    const result = lastUpdate()!.updates.result as {
      report: string;
      data: Record<string, unknown>;
    };
    expect(result.report).toBe("## Report\n\n\n\nDetails here.\n\n");
    expect(result.data.count).toBe(42);
  });

  test("multiple structured_output calls are merged", async () => {
    adapterMessages = [
      { type: "structured_output", data: { a: 1 } },
      { type: "structured_output", data: { b: 2 } },
    ];

    const flow = makeFlow({});
    await executeFlowInBackground("exec-4", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("success");
    const result = lastUpdate()!.updates.result as { data: Record<string, unknown> };
    expect(result.data).toEqual({ a: 1, b: 2 });
  });

  test("set_state persists state separately", async () => {
    adapterMessages = [
      { type: "structured_output", data: { done: true } },
      { type: "set_state", data: { cursor: "abc123" } },
    ];

    const flow = makeFlow({});
    await executeFlowInBackground("exec-5", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("success");
    expect(lastUpdate()!.updates.state).toEqual({ cursor: "abc123" });
    // State should NOT be in result
    const result = lastUpdate()!.updates.result as { data: Record<string, unknown> };
    expect(result.data.cursor).toBeUndefined();
  });

  test("invalid structured_output against schema → validation warning logged, still succeeds", async () => {
    adapterMessages = [
      { type: "structured_output", data: { summary: "done" } }, // missing count
    ];

    const flow = makeFlow({ outputSchema: OUTPUT_SCHEMA });
    await executeFlowInBackground("exec-6", testActor, "org-1", flow, makePromptContext());

    // No retries — just a warning
    expect(findLogs("output_validation")).toHaveLength(1);
    expect(findLogs("output_validation")[0]!.data!.valid).toBe(false);
    expect(lastUpdate()!.updates.status).toBe("success");
  });

  test("no output tools called → status failed", async () => {
    adapterMessages = [{ type: "progress", message: "Working..." }];

    const flow = makeFlow({});
    await executeFlowInBackground("exec-7", testActor, "org-1", flow, makePromptContext());

    expect(lastUpdate()!.updates.status).toBe("failed");
  });
});
