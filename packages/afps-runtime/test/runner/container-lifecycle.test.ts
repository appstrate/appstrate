// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect, mock } from "bun:test";
import {
  runContainerLifecycle,
  RunTimeoutError,
  type WorkloadOrchestrator,
} from "../../src/runner/container-lifecycle.ts";
import type { RunEvent } from "../../src/types/run-event.ts";

interface TestHandle {
  id: string;
  runId: string;
  role: string;
}

const RUN_ID = "exec-1";

function createMockOrchestrator(
  overrides?: Partial<WorkloadOrchestrator<TestHandle>>,
): WorkloadOrchestrator<TestHandle> {
  return {
    startWorkload: mock(() => Promise.resolve()),
    stopWorkload: mock(() => Promise.resolve()),
    removeWorkload: mock(() => Promise.resolve()),
    waitForExit: mock(() => Promise.resolve(0)),
    streamLogs: mock(async function* () {
      yield '{"type": "text_delta", "text": "hello"}';
    }),
    ...overrides,
  };
}

function createHandle(overrides?: Partial<TestHandle>): TestHandle {
  return {
    id: "container-1",
    runId: RUN_ID,
    role: "agent",
    ...overrides,
  };
}

function progressEvent(message: string): RunEvent {
  return {
    type: "appstrate.progress",
    timestamp: Date.now(),
    runId: RUN_ID,
    message,
  };
}

async function collectEvents(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

describe("runContainerLifecycle", () => {
  it("yields initial appstrate.progress event with container info", async () => {
    const orchestrator = createMockOrchestrator();
    const handle = createHandle();

    const events = await collectEvents(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        runId: RUN_ID,
        timeout: 30,
        processLogs: async function* () {},
      }),
    );

    expect(events[0]!.type).toBe("appstrate.progress");
    expect(String(events[0]!.message ?? "")).toContain("container started");
    expect((events[0]!.data as Record<string, unknown>).adapter).toBe("pi");
    expect((events[0]!.data as Record<string, unknown>).runId).toBe(RUN_ID);
  });

  it("calls startWorkload on the orchestrator", async () => {
    const orchestrator = createMockOrchestrator();
    const handle = createHandle();

    await collectEvents(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        runId: RUN_ID,
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

    const events = await collectEvents(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        runId: RUN_ID,
        timeout: 30,
        processLogs: async function* (logs) {
          for await (const line of logs) {
            yield progressEvent(line);
          }
        },
      }),
    );

    expect(events).toHaveLength(3);
    expect(events[1]!.message).toBe("line-1");
    expect(events[2]!.message).toBe("line-2");
  });

  it("waits for exit and succeeds with exit code 0", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(0)),
    });
    const handle = createHandle();

    await collectEvents(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        runId: RUN_ID,
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
      await collectEvents(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          runId: RUN_ID,
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

  it("does NOT throw on non-zero exit code when output was received", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(1)),
    });
    const handle = createHandle();

    const events = await collectEvents(
      runContainerLifecycle({
        orchestrator,
        handle,
        adapterName: "pi",
        runId: RUN_ID,
        timeout: 30,
        processLogs: async function* () {
          yield {
            type: "output.emitted",
            timestamp: Date.now(),
            runId: RUN_ID,
            data: { done: true },
          };
        },
      }),
    );

    expect(events.some((e) => e.type === "output.emitted")).toBe(true);
  });

  it("always removes workload in finally block", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.reject(new Error("wait failed"))),
    });
    const handle = createHandle();

    try {
      await collectEvents(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          runId: RUN_ID,
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
      await collectEvents(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          runId: RUN_ID,
          timeout: 30,
          signal: controller.signal,
          processLogs: async function* (logs) {
            for await (const line of logs) {
              yield progressEvent(line);
            }
          },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("cancelled");
    }
  });

  it("uses last appstrate.error message for non-zero exit code", async () => {
    const orchestrator = createMockOrchestrator({
      waitForExit: mock(() => Promise.resolve(1)),
    });
    const handle = createHandle();

    try {
      await collectEvents(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          runId: RUN_ID,
          timeout: 30,
          processLogs: async function* () {
            yield {
              type: "appstrate.error",
              timestamp: Date.now(),
              runId: RUN_ID,
              message: "OOM killed",
            };
          },
        }),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toBe("OOM killed");
    }
  });

  it("throws RunTimeoutError when the timeout fires before exit", async () => {
    const orchestrator = createMockOrchestrator({
      streamLogs: async function* () {
        // Stream completes without yielding, so waitForExit runs next.
      },
      waitForExit: mock(
        () =>
          new Promise<number>((resolve) => {
            setTimeout(() => resolve(0), 50);
          }),
      ),
    });
    const handle = createHandle();

    let caught: unknown;
    try {
      await collectEvents(
        runContainerLifecycle({
          orchestrator,
          handle,
          adapterName: "pi",
          runId: RUN_ID,
          timeout: 0.001,
          processLogs: async function* () {},
        }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RunTimeoutError);
  });
});
