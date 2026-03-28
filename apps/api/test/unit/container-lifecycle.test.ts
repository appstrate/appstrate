import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ContainerOrchestrator } from "../../src/services/orchestrator/interface.ts";
import type { WorkloadHandle, IsolationBoundary } from "../../src/services/orchestrator/types.ts";
import { runContainerLifecycle } from "../../src/services/adapters/container-lifecycle.ts";
import type { ExecutionMessage } from "../../src/services/adapters/types.ts";
import { TimeoutError } from "../../src/services/adapters/types.ts";

function createMockOrchestrator(overrides?: Partial<ContainerOrchestrator>): ContainerOrchestrator {
  return {
    initialize: mock(() => Promise.resolve()),
    shutdown: mock(() => Promise.resolve()),
    cleanupOrphans: mock(() => Promise.resolve({ workloads: 0, isolationBoundaries: 0 })),
    ensureImages: mock(() => Promise.resolve()),
    createIsolationBoundary: mock(() =>
      Promise.resolve({ id: "boundary-1", name: "test-boundary" }),
    ),
    removeIsolationBoundary: mock(() => Promise.resolve()),
    createSidecar: mock(() =>
      Promise.resolve({ id: "sidecar-1", executionId: "exec-1", role: "sidecar" }),
    ),
    createWorkload: mock(() =>
      Promise.resolve({ id: "agent-1", executionId: "exec-1", role: "agent" }),
    ),
    startWorkload: mock(() => Promise.resolve()),
    stopWorkload: mock(() => Promise.resolve()),
    removeWorkload: mock(() => Promise.resolve()),
    waitForExit: mock(() => Promise.resolve(0)),
    streamLogs: mock(async function* () {
      yield '{"type": "text_delta", "text": "hello"}';
    }),
    stopByExecutionId: mock(() => Promise.resolve("stopped" as const)),
    ...overrides,
  };
}

function createHandle(overrides?: Partial<WorkloadHandle>): WorkloadHandle {
  return {
    id: "container-1",
    executionId: "exec-1",
    role: "agent",
    ...overrides,
  };
}

async function collectMessages(gen: AsyncGenerator<ExecutionMessage>): Promise<ExecutionMessage[]> {
  const messages: ExecutionMessage[] = [];
  for await (const msg of gen) {
    messages.push(msg);
  }
  return messages;
}

describe("runContainerLifecycle", () => {
  it("yields initial progress message with container info", async () => {
    const orchestrator = createMockOrchestrator();
    const handle = createHandle();

    const messages = await collectMessages(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        executionId: "exec-1",
        timeout: 30,
        processLogs: async function* (logs) {
          for await (const line of logs) {
            yield { type: "progress" as const, message: line };
          }
        },
      }),
    );

    expect(messages[0]!.type).toBe("progress");
    expect(messages[0]!.message).toContain("container started");
    expect(messages[0]!.data?.adapter).toBe("pi");
    expect(messages[0]!.data?.executionId).toBe("exec-1");
  });

  it("calls startWorkload on the orchestrator", async () => {
    const orchestrator = createMockOrchestrator();
    const handle = createHandle();

    await collectMessages(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        executionId: "exec-1",
        timeout: 30,
        processLogs: async function* () {},
      }),
    );

    expect(orchestrator.startWorkload).toHaveBeenCalledWith(handle);
  });

  it("streams processed log messages", async () => {
    const orchestrator = createMockOrchestrator({
      streamLogs: async function* () {
        yield "line-1";
        yield "line-2";
      },
    });
    const handle = createHandle();

    const messages = await collectMessages(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        executionId: "exec-1",
        timeout: 30,
        processLogs: async function* (logs) {
          for await (const line of logs) {
            yield { type: "progress" as const, message: line };
          }
        },
      }),
    );

    // First is "container started", then the log lines
    expect(messages).toHaveLength(3);
    expect(messages[1]!.message).toBe("line-1");
    expect(messages[2]!.message).toBe("line-2");
  });

  it("waits for exit and succeeds with exit code 0", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(0)),
    });
    const handle = createHandle();

    // Should not throw
    await collectMessages(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        executionId: "exec-1",
        timeout: 30,
        processLogs: async function* () {},
      }),
    );

    expect(orchestrator.waitForExit).toHaveBeenCalledWith(handle);
  });

  it("throws on non-zero exit code without result", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(1)),
    });
    const handle = createHandle();

    try {
      await collectMessages(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          executionId: "exec-1",
          timeout: 30,
          processLogs: async function* () {},
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("exited with code 1");
    }
  });

  it("does NOT throw on non-zero exit code when result was received", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(1)),
    });
    const handle = createHandle();

    // Should not throw because an output was yielded
    const messages = await collectMessages(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        executionId: "exec-1",
        timeout: 30,
        processLogs: async function* () {
          yield { type: "output" as const, data: { done: true } };
        },
      }),
    );

    expect(messages.some((m) => m.type === "output")).toBe(true);
  });

  it("always removes workload in finally block", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.reject(new Error("wait failed"))),
    });
    const handle = createHandle();

    try {
      await collectMessages(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          executionId: "exec-1",
          timeout: 30,
          processLogs: async function* () {},
        }),
      );
    } catch {
      // Expected
    }

    expect(orchestrator.removeWorkload).toHaveBeenCalledWith(handle);
  });

  it("throws on cancellation via abort signal", async () => {
    const controller = new AbortController();
    const orchestrator = createMockOrchestrator({
      streamLogs: async function* () {
        controller.abort();
        yield "line after abort";
      },
    });
    const handle = createHandle();

    try {
      await collectMessages(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          executionId: "exec-1",
          timeout: 30,
          signal: controller.signal,
          processLogs: async function* (logs) {
            for await (const line of logs) {
              yield { type: "progress" as const, message: line };
            }
          },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("cancelled");
    }
  });

  it("uses last error message for non-zero exit code", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(1)),
    });
    const handle = createHandle();

    try {
      await collectMessages(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          executionId: "exec-1",
          timeout: 30,
          processLogs: async function* () {
            yield { type: "error" as const, message: "OOM killed" };
          },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("OOM killed");
    }
  });
});
