// SPDX-License-Identifier: Apache-2.0

/**
 * AppstrateContainerRunner — covers the BundleRunner contract, the
 * RunMessage → AfpsEvent mapping, platform-metric side-channel, and
 * error-path reducer semantics. Uses a synthetic adapter so tests run
 * without Docker.
 */

import { describe, it, expect } from "bun:test";
import {
  AppstrateContainerRunner,
  mapRunMessageToAfpsEvent,
} from "../../src/services/adapters/appstrate-container-runner.ts";
import type {
  PromptContext,
  RunAdapter,
  RunMessage,
  UploadedFile,
} from "../../src/services/adapters/types.ts";
import type { AfpsEvent, AfpsEventEnvelope } from "@appstrate/afps-runtime/types";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { NoopContextProvider } from "@appstrate/afps-runtime/providers";
import type { LoadedBundle } from "@appstrate/afps-runtime/bundle";

function makeBundle(): LoadedBundle {
  return {
    manifest: { name: "@testorg/runner", version: "1.0.0", type: "agent" },
    prompt: "ignored by mock adapter",
    files: {},
    compressedSize: 0,
    decompressedSize: 0,
  };
}

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

class RecordingSink implements EventSink {
  events: AfpsEventEnvelope[] = [];
  finalResult: RunResult | null = null;

  async onEvent(envelope: AfpsEventEnvelope): Promise<void> {
    this.events.push(envelope);
  }
  async finalize(result: RunResult): Promise<void> {
    this.finalResult = result;
  }
}

class ScriptedAdapter implements RunAdapter {
  constructor(private readonly script: RunMessage[]) {}

  async *execute(
    _runId: string,
    _ctx: PromptContext,
    _timeout: number,
    _pkg?: Buffer,
    _signal?: AbortSignal,
    _files?: UploadedFile[],
  ): AsyncGenerator<RunMessage> {
    for (const msg of this.script) yield msg;
  }
}

class FailingAdapter implements RunAdapter {
  constructor(private readonly err: Error) {}
  async *execute(): AsyncGenerator<RunMessage> {
    throw this.err;
    // unreachable yield — keeps the generator-function contract
    yield {} as RunMessage;
  }
}

describe("mapRunMessageToAfpsEvent", () => {
  it("maps the 5 canonical run-messages to AFPS events", () => {
    const cases: Array<[RunMessage, AfpsEvent]> = [
      [
        { type: "add_memory", content: "c" },
        { type: "add_memory", content: "c" },
      ],
      [
        { type: "set_state", data: { x: 1 } },
        { type: "set_state", state: { x: 1 } },
      ],
      [
        { type: "output", data: { y: 2 } },
        { type: "output", data: { y: 2 } },
      ],
      [
        { type: "report", content: "r" },
        { type: "report", content: "r" },
      ],
      [
        { type: "progress", message: "m", level: "info" },
        { type: "log", level: "info", message: "m" },
      ],
    ];
    for (const [input, expected] of cases) {
      expect(mapRunMessageToAfpsEvent(input)).toEqual(expected);
    }
  });

  it("maps adapter `error` messages to log events at level=error", () => {
    expect(mapRunMessageToAfpsEvent({ type: "error", message: "boom" })).toEqual({
      type: "log",
      level: "error",
      message: "boom",
    });
  });

  it("normalises debug log levels down to info", () => {
    expect(mapRunMessageToAfpsEvent({ type: "progress", level: "debug", message: "x" })).toEqual({
      type: "log",
      level: "info",
      message: "x",
    });
  });

  it("drops `usage` messages (non-canonical — platform side-channel only)", () => {
    expect(
      mapRunMessageToAfpsEvent({
        type: "usage",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ).toBeNull();
  });
});

describe("AppstrateContainerRunner", () => {
  it("streams mapped events through the sink + reduces to RunResult", async () => {
    const script: RunMessage[] = [
      { type: "progress", message: "starting", level: "info" },
      { type: "add_memory", content: "keep this" },
      { type: "output", data: { a: 1 } },
      { type: "output", data: { b: 2 } },
      { type: "set_state", data: { counter: 99 } },
      { type: "report", content: "done" },
    ];
    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter(script),
      buildPromptContext: async () => ({
        promptContext: makePromptContext(),
        timeout: 60,
      }),
    });
    const sink = new RecordingSink();

    const result = await runner.run({
      bundle: makeBundle(),
      context: { runId: "r_test", input: {} },
      sink,
      contextProvider: new NoopContextProvider(),
    });

    expect(sink.events.map((e) => e.event.type)).toEqual([
      "log",
      "add_memory",
      "output",
      "output",
      "set_state",
      "report",
    ]);
    // Envelope contract: sequential sequence + propagated runId.
    expect(sink.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sink.events.every((e) => e.runId === "r_test")).toBe(true);

    expect(result).toEqual(sink.finalResult!);
    expect(result.output).toEqual({ a: 1, b: 2 });
    expect(result.state).toEqual({ counter: 99 });
    expect(result.memories).toEqual([{ content: "keep this" }]);
    expect(result.report).toBe("done");
  });

  it("routes `usage` messages to the onPlatformMetric side-channel", async () => {
    const usage: RunMessage = {
      type: "usage",
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: 0.001,
    };
    const observed: RunMessage[] = [];
    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter([usage]),
      buildPromptContext: async () => ({
        promptContext: makePromptContext(),
        timeout: 60,
      }),
      onPlatformMetric: (msg) => observed.push(msg),
    });
    const sink = new RecordingSink();

    await runner.run({
      bundle: makeBundle(),
      context: { runId: "r_usage", input: {} },
      sink,
      contextProvider: new NoopContextProvider(),
    });

    // No AFPS event was emitted for `usage`.
    expect(sink.events).toHaveLength(0);
    expect(observed).toEqual([usage]);
  });

  it("synthesises an error log event + finalises when the adapter throws", async () => {
    const runner = new AppstrateContainerRunner({
      adapter: new FailingAdapter(new Error("crash")),
      buildPromptContext: async () => ({
        promptContext: makePromptContext(),
        timeout: 60,
      }),
    });
    const sink = new RecordingSink();

    const result = await runner.run({
      bundle: makeBundle(),
      context: { runId: "r_crash", input: {} },
      sink,
      contextProvider: new NoopContextProvider(),
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event).toEqual({
      type: "log",
      level: "error",
      message: "crash",
    });
    expect(result.error?.message).toBe("crash");
    // finalize was called with the reducer-computed result.
    expect(sink.finalResult).not.toBeNull();
    expect(sink.finalResult?.logs).toHaveLength(1);
  });

  it("rethrows when the abort signal triggered the error (caller owns finalisation)", async () => {
    const controller = new AbortController();
    const runner = new AppstrateContainerRunner({
      adapter: new FailingAdapter(new DOMException("aborted", "AbortError")),
      buildPromptContext: async () => {
        controller.abort();
        return { promptContext: makePromptContext(), timeout: 60 };
      },
    });
    const sink = new RecordingSink();

    await expect(
      runner.run({
        bundle: makeBundle(),
        context: { runId: "r_abort", input: {} },
        sink,
        contextProvider: new NoopContextProvider(),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();

    // When aborted, the runner delegates finalisation to the caller
    // and does NOT synthesise a sink-side log event.
    expect(sink.finalResult).toBeNull();
  });
});
