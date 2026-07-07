// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import {
  ClaudeAgentRunner,
  parseFinalJsonObject,
  type ClaudeAgentRunnerOptions,
  type ClaudeQueryInput,
} from "../src/claude-agent-runner.ts";
import type { SdkRunMessage } from "../src/sdk-event-mapper.ts";

/** In-memory sink capturing the ordered event stream + the finalized result. */
function memorySink() {
  const events: RunEvent[] = [];
  let result: RunResult | null = null;
  return {
    events,
    get result() {
      return result;
    },
    sink: {
      async handle(e: RunEvent): Promise<void> {
        events.push(e);
      },
      async finalize(r: RunResult): Promise<void> {
        result = r;
      },
    },
  };
}

/** A fake `query` that yields a scripted message sequence and captures the call. */
function fakeQuery(messages: SdkRunMessage[]) {
  const calls: ClaudeQueryInput[] = [];
  const fn = (input: ClaudeQueryInput): AsyncIterable<SdkRunMessage> => {
    calls.push(input);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
  return { fn, calls };
}

const baseOpts = (over: Partial<ClaudeAgentRunnerOptions> = {}): ClaudeAgentRunnerOptions => ({
  binaryPath: "/bin/claude",
  modelId: "claude-haiku-4-5",
  systemPrompt: "You are an Appstrate agent.",
  baseUrl: "http://sidecar:8088/llm",
  placeholderToken: "placeholder",
  cwd: "/workspace",
  now: () => 1_700_000_000_000,
  ...over,
});

const ctx = { runId: "run_1", input: "do the thing", memories: [], config: {} };

describe("ClaudeAgentRunner — happy path", () => {
  it("emits progress + output.emitted and finalizes success with usage/cost/output", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.02,
        duration_ms: 1234,
        usage: { input_tokens: 100, output_tokens: 40 },
        structured_output: { ok: true, n: 3 },
      },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });

    expect(m.result?.status).toBe("success");
    expect(m.result?.output).toEqual({ ok: true, n: 3 });
    expect(m.result?.cost).toBe(0.02);
    expect(m.result?.usage).toMatchObject({ input_tokens: 100, output_tokens: 40 });
    expect(m.result?.durationMs).toBe(1234);

    const types = m.events.map((e) => e.type);
    expect(types).toContain("appstrate.progress");
    expect(types).toContain("appstrate.metric");
    expect(types).toContain("output.emitted");
    // The claude engine always states its native delivery mechanism so
    // finalize phrases output-validation failures correctly (issue #833).
    expect(m.result?.outputMode).toBe("native");
  });

  it("passes outputFormat, the sidecar MCP server (no in-process server), native tools, and curated env", async () => {
    const { fn, calls } = fakeQuery([
      { type: "result", subtype: "success", is_error: false, usage: {} },
    ]);
    await new ClaudeAgentRunner(
      baseOpts({
        query: fn,
        outputSchema: { type: "object", properties: { x: { type: "number" } } },
        sidecarMcp: { url: "http://sidecar:8088/mcp", headers: { Host: "sidecar" } },
      }),
    ).run({ context: ctx, eventSink: memorySink().sink, bundle: undefined as never });

    const opts = calls[0]!.options as Record<string, any>;
    expect(opts.outputFormat).toEqual({
      type: "json_schema",
      schema: { type: "object", properties: { x: { type: "number" } } },
    });
    // All tools (integrations + runtime tools) come from the sidecar `/mcp` —
    // no in-process MCP server is registered anymore.
    expect(opts.mcpServers.appstrate).toEqual({
      type: "http",
      url: "http://sidecar:8088/mcp",
      headers: { Host: "sidecar" },
    });
    expect(Object.keys(opts.mcpServers)).toEqual(["appstrate"]);
    // Native tools enabled by default → no `tools: []` opt-out key.
    expect(opts.tools).toBeUndefined();
    expect(opts.maxTurns).toBe(100);
    expect(opts.permissionMode).toBe("bypassPermissions");
    // Curated env: gateway pointers, no ambient API key, kickoff from input.
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("http://sidecar:8088/llm");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("");
    expect(calls[0]!.prompt).toBe("do the thing");
  });
});

describe("ClaudeAgentRunner — final-message output fallback (issue #833)", () => {
  const outputSchema = {
    type: "object",
    properties: { numbers: { type: "array" } },
    required: ["numbers"],
  };
  const successResult: SdkRunMessage = {
    type: "result",
    subtype: "success",
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it("captures a schema-declaring run's final JSON text message when structured_output is absent", async () => {
    // The #833 shape: the model wrote the deliverable as its final text
    // message instead of calling `StructuredOutput` → the SDK result carries
    // no `structured_output`, but the run must still end with output.
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "working on it" }] } },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: '{"numbers": [1, 2, 3]}' }] },
      },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });

    expect(m.result?.status).toBe("success");
    expect(m.result?.output).toEqual({ numbers: [1, 2, 3] });
    expect(m.events.map((e) => e.type)).toContain("output.emitted");
  });

  it("captures a fenced ```json final message", async () => {
    const { fn } = fakeQuery([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: '```json\n{"numbers": []}\n```' }] },
      },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toEqual({ numbers: [] });
  });

  it("does not promote a stale mid-run draft: a later tool_use-only turn clears the final-message slot", async () => {
    // The fallback must read the run's FINAL message, not the last text ever
    // seen — otherwise a mid-run JSON draft becomes the deliverable and a
    // loose schema silently validates wrong output.
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: '{"numbers": [9, 9]}' }] } },
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__appstrate__log" }] },
      },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toBeNull();
    expect(m.events.map((e) => e.type)).not.toContain("output.emitted");
  });

  it("ignores subagent/sidechain text — a subagent's JSON is never the run's deliverable", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "delegating" }] } },
      {
        type: "assistant",
        parent_tool_use_id: "task_1",
        message: { content: [{ type: "text", text: '{"numbers": [7]}' }] },
      },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    // Main thread's final message is "delegating" (not JSON) → no capture.
    expect(m.result?.output).toBeNull();
  });

  it("treats structured_output: null as not delivered — the fallback still engages", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: '{"numbers": [4]}' }] } },
      { ...successResult, structured_output: null } as SdkRunMessage,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toEqual({ numbers: [4] });
  });

  it("captures a plain-string-content final message", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: '{"numbers": [5]}' } },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toEqual({ numbers: [5] });
  });

  it("prefers the SDK's structured_output over the final text message", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: '{"numbers": [9]}' }] } },
      { ...successResult, structured_output: { numbers: [1] } } as SdkRunMessage,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toEqual({ numbers: [1] });
  });

  it("leaves the run output-less when the final message is not a JSON object", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "All done, boss!" }] } },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toBeNull();
    expect(m.events.map((e) => e.type)).not.toContain("output.emitted");
  });

  it("does not fall back when the run declares no output schema", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: '{"numbers": [1]}' }] } },
      successResult,
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.output).toBeNull();
    expect(m.events.map((e) => e.type)).not.toContain("output.emitted");
  });

  it("does not fall back on a failed terminal", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: '{"numbers": [1]}' }] } },
      { type: "result", subtype: "error_max_turns", is_error: true, usage: {} },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, outputSchema })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.output).toBeNull();
  });
});

describe("parseFinalJsonObject", () => {
  it("parses a bare JSON object", () => {
    expect(parseFinalJsonObject('{"a": 1}')).toEqual({ a: 1 });
  });
  it("parses a fenced JSON object (with or without the json language tag)", () => {
    expect(parseFinalJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseFinalJsonObject('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it("tolerates fence variants: uppercase tag, closing fence glued to the JSON", () => {
    expect(parseFinalJsonObject('```JSON\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseFinalJsonObject('```json\n{"a": 1}```')).toEqual({ a: 1 });
  });
  it("rejects an unclosed fence without pathological scanning", () => {
    const big = "```json\n" + "{\n".padEnd(200_000, " \n");
    const start = performance.now();
    expect(parseFinalJsonObject(big)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
  });
  it("rejects arrays, scalars, prose, malformed JSON, and empty input", () => {
    expect(parseFinalJsonObject("[1, 2]")).toBeUndefined();
    expect(parseFinalJsonObject('"str"')).toBeUndefined();
    expect(parseFinalJsonObject('Done! {"a": 1}')).toBeUndefined();
    expect(parseFinalJsonObject('{"a": ')).toBeUndefined();
    expect(parseFinalJsonObject("")).toBeUndefined();
    expect(parseFinalJsonObject(null)).toBeUndefined();
  });
});

describe("ClaudeAgentRunner — failure paths", () => {
  it("maps a failed result to status failed with a structured error", async () => {
    const { fn } = fakeQuery([
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["too many"],
        usage: {},
      },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.error).toMatchObject({ code: "max_turns", message: "too many" });
  });

  it("finalizes failed + emits appstrate.error when the SDK query throws", async () => {
    const fn = () =>
      (async function* (): AsyncIterable<SdkRunMessage> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
        throw new Error("binary crashed");
      })();
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.error?.message).toBe("binary crashed");
    expect(m.events.some((e) => e.type === "appstrate.error")).toBe(true);
  });

  it("treats a stream with no result message as failed (no_result)", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "done?" }] } },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.error?.code).toBe("no_result");
  });
});

describe("ClaudeAgentRunner — cancellation", () => {
  it("throws (does not finalize) when the signal is already aborted", async () => {
    const { fn } = fakeQuery([{ type: "result", subtype: "success", is_error: false, usage: {} }]);
    const m = memorySink();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClaudeAgentRunner(baseOpts({ query: fn })).run({
        context: ctx,
        eventSink: m.sink,
        bundle: undefined as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(m.result).toBeNull();
  });

  it("propagates a mid-stream abort without finalizing", async () => {
    const controller = new AbortController();
    const fn = () =>
      (async function* (): AsyncIterable<SdkRunMessage> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "step" }] } };
        controller.abort();
        throw new Error("aborted by signal");
      })();
    const m = memorySink();
    await expect(
      new ClaudeAgentRunner(baseOpts({ query: fn })).run({
        context: ctx,
        eventSink: m.sink,
        bundle: undefined as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(m.result).toBeNull();
  });
});

describe("ClaudeAgentRunner — runtime-event drain", () => {
  // The sidecar executes `log` once and journals `log.written`; the runner
  // drains the journal after a message boundary and re-emits on its sink (the
  // SDK drops the result `_meta`, so the journal is the only source).
  const messages: SdkRunMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__appstrate__log",
            input: { level: "info", message: "hi from claude" },
          },
        ],
      },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] },
    },
    { type: "result", subtype: "success", is_error: false, usage: {} },
  ];

  it("emits journaled runtime events drained from the sidecar with the run id stamped", async () => {
    const { fn } = fakeQuery(messages);
    let finalDrained = false;
    let yielded = false;
    const drainer = {
      async drain(opts?: { final?: boolean }) {
        if (opts?.final) finalDrained = true;
        if (yielded) return [];
        yielded = true;
        return [{ type: "log.written", level: "info", message: "hi from claude" }] as never;
      },
    };
    const m = memorySink();
    await new ClaudeAgentRunner(
      baseOpts({
        query: fn,
        drainer,
        sidecarMcp: { url: "http://sidecar:8088/mcp", headers: { Host: "sidecar" } },
      }),
    ).run({ context: ctx, eventSink: m.sink, bundle: undefined as never });

    const written = m.events.find((e) => e.type === "log.written") as
      | (RunEvent & { level?: string; message?: string })
      | undefined;
    expect(written).toBeDefined();
    expect(written?.message).toBe("hi from claude");
    expect(written?.level).toBe("info");
    expect(written?.runId).toBe("run_1");
    expect(finalDrained).toBe(true);
  });

  it("runs without a drainer (no runtime tools) and emits no runtime events", async () => {
    const { fn } = fakeQuery(messages);
    const m = memorySink();
    await new ClaudeAgentRunner(
      baseOpts({
        query: fn,
        sidecarMcp: { url: "http://sidecar:8088/mcp", headers: { Host: "sidecar" } },
      }),
    ).run({ context: ctx, eventSink: m.sink, bundle: undefined as never });
    expect(m.events.some((e) => e.type === "log.written")).toBe(false);
    expect(m.result?.status).toBe("success");
  });
});
describe("ClaudeAgentRunner — idle-stall watchdog", () => {
  // A `query` that yields an optional prelude, then hangs until the SDK's own
  // AbortController (passed in `options.abortController`) fires — at which point
  // it throws, mirroring how the real SDK surfaces an aborted run. This models
  // the claude-code binary silently retrying an upstream 429 with no messages.
  function hangingQuery(prelude: SdkRunMessage[] = []) {
    const fn = (input: ClaudeQueryInput): AsyncIterable<SdkRunMessage> => {
      const controller = (input.options as { abortController?: AbortController }).abortController;
      return (async function* () {
        for (const m of prelude) yield m;
        await new Promise<void>((resolve) => {
          const sig = controller?.signal;
          if (!sig || sig.aborted) return resolve();
          sig.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted by SDK controller");
      })();
    };
    return { fn };
  }

  it("aborts a silent hang → failed with an explicit rate-limit message", async () => {
    const { fn } = hangingQuery();
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, idleTimeoutMs: 20 })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.error?.message).toMatch(/rate limit/i);
    expect(m.result?.error?.message).toMatch(/no agent activity/i);
    expect(m.events.some((e) => e.type === "appstrate.error")).toBe(true);
  });

  it("re-arms after each message → still fails when the stream stalls mid-run", async () => {
    const { fn } = hangingQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, idleTimeoutMs: 20 })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("failed");
    expect(m.result?.error?.message).toMatch(/no agent activity/i);
  });

  it("does not fire on a fast run even with a tiny window (no false positive)", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "quick" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.01,
        duration_ms: 10,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn, idleTimeoutMs: 20 })).run({
      context: ctx,
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("success");
  });

  it("a real signal abort racing the watchdog still rethrows (not masked as a stall)", async () => {
    const controller = new AbortController();
    const fn = () =>
      (async function* (): AsyncIterable<SdkRunMessage> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "step" }] } };
        controller.abort();
        throw new Error("aborted by signal");
      })();
    const m = memorySink();
    await expect(
      new ClaudeAgentRunner(baseOpts({ query: fn, idleTimeoutMs: 20 })).run({
        context: ctx,
        eventSink: m.sink,
        bundle: undefined as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(m.result).toBeNull();
  });
});
describe("ClaudeAgentRunner — timeout watchdog", () => {
  // Same shape as the idle test's hanging query: yields an optional prelude,
  // then blocks until the SDK's own AbortController (which BOTH watchdogs and a
  // real cancel drive) fires, at which point it throws like the real SDK.
  function hangingQuery(prelude: SdkRunMessage[] = []) {
    const fn = (input: ClaudeQueryInput): AsyncIterable<SdkRunMessage> => {
      const controller = (input.options as { abortController?: AbortController }).abortController;
      return (async function* () {
        for (const m of prelude) yield m;
        await new Promise<void>((resolve) => {
          const sig = controller?.signal;
          if (!sig || sig.aborted) return resolve();
          sig.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted by SDK controller");
      })();
    };
    return { fn };
  }

  it("fires the budget → finalizes a first-class `timeout` terminal (status + message + duration)", async () => {
    const { fn } = hangingQuery();
    const m = memorySink();
    // Real clock so the execution-window duration is a positive measurement.
    // `0.05` s → a 50ms watchdog (the field is seconds; the runner × 1000).
    await new ClaudeAgentRunner(baseOpts({ query: fn, now: Date.now, idleTimeoutMs: 0 })).run({
      context: { ...ctx, timeoutSeconds: 0.05 },
      eventSink: m.sink,
      bundle: undefined as never,
    });

    expect(m.result?.status).toBe("timeout");
    expect(m.result?.error?.code).toBe("timeout");
    expect(m.result?.error?.message).toMatch(/timed out after/i);
    // Duration is the runner-stamped execution window (from run() start), not
    // left for the platform to infer as `now - startedAt` (which folds in boot).
    expect(typeof m.result?.durationMs).toBe("number");
    expect(m.result!.durationMs!).toBeGreaterThanOrEqual(0);
    expect(m.events.some((e) => e.type === "appstrate.error")).toBe(true);
  });

  it("does not fire on a fast run even with a tiny budget (no false positive)", async () => {
    const { fn } = fakeQuery([
      { type: "assistant", message: { content: [{ type: "text", text: "quick" }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 5,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: { ...ctx, timeoutSeconds: 0.05 },
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("success");
  });

  it("a real cancel is NOT masked as a timeout (abort-rethrow arm wins, no finalize)", async () => {
    const controller = new AbortController();
    const fn = () =>
      (async function* (): AsyncIterable<SdkRunMessage> {
        yield { type: "assistant", message: { content: [{ type: "text", text: "step" }] } };
        controller.abort();
        throw new Error("aborted by signal");
      })();
    const m = memorySink();
    await expect(
      // Budget set generously so only the cancel fires — proving cancel
      // precedence over the timeout terminal.
      new ClaudeAgentRunner(baseOpts({ query: fn, idleTimeoutMs: 0 })).run({
        context: { ...ctx, timeoutSeconds: 100 },
        eventSink: m.sink,
        bundle: undefined as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(m.result).toBeNull();
  });

  it("no budget set → watchdog never arms (a completed run still succeeds)", async () => {
    const { fn } = fakeQuery([{ type: "result", subtype: "success", is_error: false, usage: {} }]);
    const m = memorySink();
    await new ClaudeAgentRunner(baseOpts({ query: fn })).run({
      context: ctx, // no timeoutSeconds
      eventSink: m.sink,
      bundle: undefined as never,
    });
    expect(m.result?.status).toBe("success");
  });
});
// `buildClaudeSdkEnv` is shared infra — its tests live in
// `@appstrate/core` (test/claude-binary.test.ts).
