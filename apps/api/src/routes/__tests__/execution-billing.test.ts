import { describe, test, expect, mock, beforeEach } from "bun:test";
import type {
  ExecutionAdapter,
  ExecutionMessage,
  PromptContext,
} from "../../services/adapters/types.ts";
import type { LoadedFlow } from "../../types/index.ts";
import { packageVersionsStub } from "../../services/__tests__/_db-mock.ts";

// --- Mocks ---

const noop = () => {};
const loggerErrorCalls: unknown[][] = [];

mock.module("../../lib/logger.ts", () => ({
  logger: {
    debug: noop,
    info: noop,
    warn: noop,
    error: (...args: unknown[]) => {
      loggerErrorCalls.push(args);
    },
  },
}));

mock.module("../../lib/db.ts", () => ({
  db: {},
}));

const logs: { event: string; data: Record<string, unknown> | null }[] = [];
const updates: { id: string; updates: Record<string, unknown> }[] = [];

mock.module("../../services/state/index.ts", () => ({
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

// Adapter mock with controllable messages
let adapterMessages: ExecutionMessage[] = [];

class MockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

let adapterError: Error | null = null;

mock.module("../../services/adapters/index.ts", () => ({
  getAdapter: (): ExecutionAdapter => ({
    async *execute(): AsyncGenerator<ExecutionMessage> {
      for (const msg of adapterMessages) {
        yield msg;
      }
      if (adapterError) {
        throw adapterError;
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

// Cloud module mock — controllable per test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCloud: any = null;

mock.module("../../lib/cloud-loader.ts", () => ({
  getCloudModule: () => mockCloud,
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

function makeFlow(): LoadedFlow {
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
      timeout: 300,
    } as unknown as LoadedFlow["manifest"],
  };
}

function setAdapterMessages(messages: ExecutionMessage[]) {
  adapterMessages = messages;
}

function findUpdatesWithStatus(status: string) {
  return updates.filter((u) => u.updates.status === status);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function callArgs(fn: unknown, callIdx = 0): any[] {
  return (fn as any).mock.calls[callIdx] ?? [];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- Tests ---

beforeEach(() => {
  logs.length = 0;
  updates.length = 0;
  loggerErrorCalls.length = 0;
  adapterMessages = [];
  adapterError = null;
  mockCloud = null;
});

describe("executeFlowInBackground — billing integration", () => {
  test("Cloud null (OSS mode) — no billing, execution completes normally", async () => {
    mockCloud = null;

    setAdapterMessages([
      { type: "progress", message: "Working..." },
      { type: "structured_output", data: { answer: "done" } },
    ]);

    const flow = makeFlow();
    await executeFlowInBackground("exec-oss-1", "user-1", "org-1", flow, makePromptContext());

    // Execution should succeed
    const successUpdates = findUpdatesWithStatus("success");
    expect(successUpdates.length).toBeGreaterThanOrEqual(1);
  });

  test("Cloud present — records usage on successful execution with cost", async () => {
    const recordUsageMock = mock(async () => {});

    mockCloud = {
      cloudHooks: {
        recordUsage: recordUsageMock,
      },
    };

    setAdapterMessages([
      { type: "progress", message: "Working...", cost: 0.01 },
      { type: "structured_output", data: { answer: "done" }, cost: 0.02 },
    ]);

    const flow = makeFlow();
    await executeFlowInBackground("exec-cloud-1", "user-1", "org-1", flow, makePromptContext());

    // Execution should succeed
    const successUpdates = findUpdatesWithStatus("success");
    expect(successUpdates.length).toBeGreaterThanOrEqual(1);

    // recordUsage called with (orgId, executionId, accumulatedCost)
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(callArgs(recordUsageMock)[0]).toBe("org-1");
    expect(callArgs(recordUsageMock)[1]).toBe("exec-cloud-1");
    expect(callArgs(recordUsageMock)[2]).toBeCloseTo(0.03);
  });

  // Note: Quota check now happens in the route handler (returns 402),
  // not in executeFlowInBackground. See route-level tests for quota coverage.

  test("Execution fails with cost > 0 — no charge (failed executions are free)", async () => {
    const recordUsageMock = mock(async () => {});

    mockCloud = {
      cloudHooks: {
        recordUsage: recordUsageMock,
      },
    };

    // Emit a message with cost, then throw an error
    setAdapterMessages([{ type: "progress", message: "Working...", cost: 0.05 }]);
    adapterError = new Error("LLM API error");

    const flow = makeFlow();
    await executeFlowInBackground("exec-fail-cost-1", "user-1", "org-1", flow, makePromptContext());

    // Execution should fail
    const failedUpdates = findUpdatesWithStatus("failed");
    expect(failedUpdates.length).toBeGreaterThanOrEqual(1);

    // recordUsage should NOT be called (failed execution = no charge)
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  test("Execution fails with cost = 0 — no charge", async () => {
    const recordUsageMock = mock(async () => {});

    mockCloud = {
      cloudHooks: {
        recordUsage: recordUsageMock,
      },
    };

    // Throw immediately with no cost emitted
    setAdapterMessages([]);
    adapterError = new Error("Connection refused");

    const flow = makeFlow();
    await executeFlowInBackground(
      "exec-fail-nocost-1",
      "user-1",
      "org-1",
      flow,
      makePromptContext(),
    );

    // Execution should fail
    const failedUpdates = findUpdatesWithStatus("failed");
    expect(failedUpdates.length).toBeGreaterThanOrEqual(1);

    // No billing calls at all for failed executions
    expect(recordUsageMock).not.toHaveBeenCalled();
  });

  test("recordUsage fails — error logged, execution not impacted", async () => {
    const recordUsageMock = mock(async () => {
      throw new Error("Stripe API error");
    });

    mockCloud = {
      cloudHooks: {
        recordUsage: recordUsageMock,
      },
    };

    setAdapterMessages([
      { type: "progress", message: "Working...", cost: 0.01 },
      { type: "structured_output", data: { answer: "done" }, cost: 0.02 },
    ]);

    const flow = makeFlow();
    await executeFlowInBackground(
      "exec-usage-fail-1",
      "user-1",
      "org-1",
      flow,
      makePromptContext(),
    );

    // Execution should still succeed (billing failure doesn't impact execution)
    const successUpdates = findUpdatesWithStatus("success");
    expect(successUpdates.length).toBeGreaterThanOrEqual(1);

    // recordUsage was attempted
    expect(recordUsageMock).toHaveBeenCalledTimes(1);

    // Error should be logged
    expect(loggerErrorCalls.length).toBeGreaterThanOrEqual(1);
    const billingErrorLog = loggerErrorCalls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Failed to record usage"),
    );
    expect(billingErrorLog).toBeDefined();
  });
});
