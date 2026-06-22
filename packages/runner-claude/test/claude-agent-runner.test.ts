// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import {
  ClaudeAgentRunner,
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
        maxTurns: 42,
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
    expect(opts.maxTurns).toBe(42);
    expect(opts.permissionMode).toBe("bypassPermissions");
    // Curated env: gateway pointers, no ambient API key, kickoff from input.
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("http://sidecar:8088/llm");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("");
    expect(calls[0]!.prompt).toBe("do the thing");
  });

  it("opts out of native tools when enableNativeTools is false", async () => {
    const { fn, calls } = fakeQuery([
      { type: "result", subtype: "success", is_error: false, usage: {} },
    ]);
    await new ClaudeAgentRunner(baseOpts({ query: fn, enableNativeTools: false })).run({
      context: ctx,
      eventSink: memorySink().sink,
      bundle: undefined as never,
    });
    expect((calls[0]!.options as Record<string, unknown>).tools).toEqual([]);
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
// `buildClaudeSdkEnv` is shared infra — its tests live in
// `@appstrate/core` (test/claude-binary.test.ts).
