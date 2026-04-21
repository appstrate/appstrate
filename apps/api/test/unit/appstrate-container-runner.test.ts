// SPDX-License-Identifier: Apache-2.0

/**
 * AppstrateContainerRunner — covers the event-forwarding contract, the
 * reducer-backed RunResult, and the error path. Uses a synthetic adapter
 * so tests run without Docker. The runner forwards whatever
 * {@link RunEvent}s the adapter yields straight to the sink; mapping from
 * Pi SDK output lines to RunEvents is covered in `pi-adapter.test.ts` /
 * `pi-parser.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { AppstrateContainerRunner } from "../../src/services/adapters/appstrate-container-runner.ts";
import type { PromptContext, RunAdapter, UploadedFile } from "../../src/services/adapters/types.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import type { AppstrateEventSink } from "../../src/services/adapters/appstrate-event-sink.ts";

function makePromptContext(): PromptContext {
  return {
    schemaVersion: "1.1",
    runId: "r_test",
    rawPrompt: "unused",
    tokens: {},
    config: {},
    previousState: null,
    input: {},
    schemas: {},
    providers: [],
    memories: [],
    llmModel: "test",
    llmConfig: {
      api: "anthropic-messages",
      modelId: "test",
      apiKey: "test",
      baseUrl: "",
      input: ["text"],
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      } as PromptContext["llmConfig"]["cost"],
    },
    proxyUrl: null,
    timeout: 60,
    availableTools: [],
    availableSkills: [],
    toolDocs: [],
  };
}

function event(runId: string, type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: Date.now(), runId, ...extra };
}

class ScriptedAdapter implements RunAdapter {
  constructor(private readonly script: RunEvent[]) {}

  async *execute(
    _runId: string,
    _ctx: PromptContext,
    _timeout: number,
    _pkg?: Buffer,
    _signal?: AbortSignal,
    _files?: UploadedFile[],
  ): AsyncGenerator<RunEvent> {
    for (const ev of this.script) yield ev;
  }
}

class FailingAdapter implements RunAdapter {
  constructor(private readonly err: Error) {}
  async *execute(): AsyncGenerator<RunEvent> {
    throw this.err;
    // unreachable yield — keeps the generator-function contract
    yield {} as RunEvent;
  }
}

/**
 * Minimal sink that records events and tracks final RunResult without
 * touching the DB — shares the structural surface the runner expects
 * from {@link AppstrateEventSink} (handle + finalize).
 */
class RecordingSink {
  events: RunEvent[] = [];
  finalResult: RunResult | null = null;

  async handle(event: RunEvent): Promise<void> {
    this.events.push(event);
  }
  async finalize(result: RunResult): Promise<void> {
    this.finalResult = result;
  }
}

describe("AppstrateContainerRunner", () => {
  it("streams events through the sink and reduces to RunResult", async () => {
    const runId = "r_test";
    const script: RunEvent[] = [
      event(runId, "appstrate.progress", { message: "starting", level: "info" }),
      event(runId, "memory.added", { content: "keep this" }),
      event(runId, "output.emitted", { data: { a: 1 } }),
      event(runId, "output.emitted", { data: { b: 2 } }),
      event(runId, "state.set", { state: { counter: 99 } }),
      event(runId, "report.appended", { content: "done" }),
    ];
    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter(script),
      plan: { promptContext: makePromptContext(), timeout: 60 },
    });
    const sink = new RecordingSink();

    const result = await runner.run({
      runId,
      sink: sink as unknown as AppstrateEventSink,
    });

    expect(sink.events.map((e) => e.type)).toEqual([
      "appstrate.progress",
      "memory.added",
      "output.emitted",
      "output.emitted",
      "state.set",
      "report.appended",
    ]);

    expect(result).toEqual(sink.finalResult!);
    expect(result.output).toEqual({ a: 1, b: 2 });
    expect(result.state).toEqual({ counter: 99 });
    expect(result.memories).toEqual([{ content: "keep this" }]);
    expect(result.report).toBe("done");
  });

  it("forwards appstrate.metric events to the sink (aggregator reads them)", async () => {
    const runId = "r_usage";
    const metric = event(runId, "appstrate.metric", {
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: 0.001,
    });
    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter([metric]),
      plan: { promptContext: makePromptContext(), timeout: 60 },
    });
    const sink = new RecordingSink();

    await runner.run({ runId, sink: sink as unknown as AppstrateEventSink });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.type).toBe("appstrate.metric");
  });

  it("synthesises an appstrate.error event + finalises when the adapter throws", async () => {
    const runId = "r_crash";
    const runner = new AppstrateContainerRunner({
      adapter: new FailingAdapter(new Error("crash")),
      plan: { promptContext: makePromptContext(), timeout: 60 },
    });
    const sink = new RecordingSink();

    const result = await runner.run({
      runId,
      sink: sink as unknown as AppstrateEventSink,
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.type).toBe("appstrate.error");
    expect(sink.events[0]!.message).toBe("crash");
    expect(result.error?.message).toBe("crash");
    expect(sink.finalResult).not.toBeNull();
  });

  it("rethrows when the abort signal triggered the error (caller owns finalisation)", async () => {
    const controller = new AbortController();
    controller.abort();
    const runId = "r_abort";
    const runner = new AppstrateContainerRunner({
      adapter: new FailingAdapter(new DOMException("aborted", "AbortError")),
      plan: { promptContext: makePromptContext(), timeout: 60 },
    });
    const sink = new RecordingSink();

    await expect(
      runner.run({
        runId,
        sink: sink as unknown as AppstrateEventSink,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    expect(sink.finalResult).toBeNull();
  });
});
