/**
 * Integration tests — verifies that execution status transitions dispatch webhook events
 * with the correct event type, executionId, packageId, and extra data.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type {
  ExecutionAdapter,
  ExecutionMessage,
  PromptContext,
} from "../../services/adapters/types.ts";
import type { LoadedFlow } from "../../types/index.ts";
import { packageVersionsStub, schemaStubs } from "../../services/__tests__/_db-mock.ts";

// --- Mocks ---

const noop = () => {};
mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db: {} }));
mock.module("@appstrate/db/schema", () => schemaStubs);

mock.module("../../services/state/index.ts", () => ({
  appendExecutionLog: mock(async () => 1),
  updateExecution: mock(async () => {}),
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

class MockModelNotConfiguredError extends Error {
  constructor() {
    super("No LLM model configured");
    this.name = "ModelNotConfiguredError";
  }
}

mock.module("../../services/env-builder.ts", () => ({
  ModelNotConfiguredError: MockModelNotConfiguredError,
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
  requireOwnedPackage: mock(() => mock()),
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
      for (const msg of adapterMessages) yield msg;
    },
  }),
  TimeoutError: MockTimeoutError,
}));

mock.module("../../services/package-storage.ts", () => ({
  getPackageZip: mock(async () => null),
}));

mock.module("../../lib/cloud-loader.ts", () => ({
  getCloudModule: () => null,
}));

// --- Webhook dispatch tracking ---

const webhookCalls: { orgId: string; eventType: string; execution: Record<string, unknown> }[] = [];

mock.module("../../services/webhooks.ts", () => ({
  dispatchWebhookEvents: async (
    orgId: string,
    eventType: string,
    execution: Record<string, unknown>,
  ) => {
    webhookCalls.push({ orgId, eventType, execution });
  },
  // Other exports needed by the process-global mock
  createWebhook: async () => ({}),
  listWebhooks: async () => [],
  getWebhook: async () => ({}),
  updateWebhook: async () => ({}),
  deleteWebhook: async () => {},
  rotateSecret: async () => ({ secret: "whsec_test" }),
  listDeliveries: async () => [],
  buildEventEnvelope: () => ({ eventId: "evt_test", payload: {} }),
  buildSignedHeaders: async () => ({}),
  validateWebhookUrl: () => {},
  validateEvents: (e: unknown) => e,
  initWebhookWorker: () => {},
  shutdownWebhookWorker: async () => {},
}));

// --- Import after mocks ---

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
      apiKey: "sk-test",
    },
  };
}

function makeFlow(): LoadedFlow {
  return {
    id: "@test/my-flow",
    prompt: "test",
    skills: [],
    tools: [],
    source: "system",
    manifest: {
      schemaVersion: "1.0",
      name: "my-flow",
      displayName: "My Flow",
      description: "test",
      author: "test",
      dependencies: { providers: {}, skills: {}, tools: {} },
      timeout: 300,
    } as unknown as LoadedFlow["manifest"],
  };
}

// --- Tests ---

beforeEach(() => {
  webhookCalls.length = 0;
  adapterMessages = [];
});

describe("Webhook dispatch on execution transitions", () => {
  test("dispatches execution.started when execution begins", async () => {
    adapterMessages = [{ type: "report_final", content: "Done" }];

    await executeFlowInBackground("exec_1", "usr_1", "org-1", makeFlow(), makePromptContext());

    const started = webhookCalls.find((c) => c.eventType === "execution.started");
    expect(started).toBeDefined();
    expect(started!.orgId).toBe("org-1");
    expect(started!.execution.id).toBe("exec_1");
    expect(started!.execution.packageId).toBe("@test/my-flow");
  });

  test("dispatches execution.completed on success", async () => {
    adapterMessages = [
      { type: "report_final", content: "All done" },
      { type: "structured_output", data: { count: 42 } },
    ];

    await executeFlowInBackground("exec_2", "usr_1", "org-1", makeFlow(), makePromptContext());

    const completed = webhookCalls.find((c) => c.eventType === "execution.completed");
    expect(completed).toBeDefined();
    expect(completed!.execution.id).toBe("exec_2");
    expect(completed!.execution.status).toBe("completed");
    expect(completed!.execution.result).toBeDefined();
    expect(typeof completed!.execution.duration).toBe("number");
  });

  test("dispatches execution.failed when adapter produces no result", async () => {
    adapterMessages = []; // No output → failed

    await executeFlowInBackground("exec_3", "usr_1", "org-1", makeFlow(), makePromptContext());

    const failed = webhookCalls.find((c) => c.eventType === "execution.failed");
    expect(failed).toBeDefined();
    expect(failed!.execution.id).toBe("exec_3");
    expect(failed!.execution.status).toBe("failed");
    expect(failed!.execution.error).toBeDefined();
  });

  test("both started and completed dispatched for successful execution", async () => {
    adapterMessages = [{ type: "report_final", content: "Done" }];

    await executeFlowInBackground("exec_5", "usr_1", "org-1", makeFlow(), makePromptContext());

    const types = webhookCalls.map((c) => c.eventType);
    expect(types).toContain("execution.started");
    expect(types).toContain("execution.completed");
  });

  test("all dispatches use the correct orgId and packageId", async () => {
    adapterMessages = [{ type: "report_final", content: "Done" }];

    await executeFlowInBackground("exec_6", "usr_1", "org-42", makeFlow(), makePromptContext());

    for (const call of webhookCalls) {
      expect(call.orgId).toBe("org-42");
      expect(call.execution.packageId).toBe("@test/my-flow");
    }
  });
});
