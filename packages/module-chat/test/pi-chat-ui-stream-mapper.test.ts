// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PiChatUiStreamMapper, stripMcpToolPrefix } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";

/** Feed a list of pi session events through one mapper, collect all UI chunks. */
function run(events: AgentSessionEvent[]) {
  const mapper = new PiChatUiStreamMapper();
  const chunks = events.flatMap((e) => mapper.map(e));
  return { chunks, mapper };
}

describe("stripMcpToolPrefix", () => {
  it("strips the mcp__<server>__ prefix but keeps inner __", () => {
    expect(stripMcpToolPrefix("mcp__platform__search_operations")).toBe("search_operations");
    expect(stripMcpToolPrefix("mcp__platform__run__and__wait")).toBe("run__and__wait");
  });
  it("passes non-MCP names through", () => {
    expect(stripMcpToolPrefix("output")).toBe("output");
  });
});

describe("PiChatUiStreamMapper", () => {
  it("maps a text turn to start-step → text-start/delta/end → finish-step", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "lo",
          partial: {},
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Hello",
          partial: {},
        },
      },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]);

    expect(chunks).toEqual([
      { type: "start-step" },
      { type: "text-start", id: "1-0" },
      { type: "text-delta", id: "1-0", delta: "Hel" },
      { type: "text-delta", id: "1-0", delta: "lo" },
      { type: "text-end", id: "1-0" },
      { type: "finish-step" },
    ]);
  });

  it("maps a tool call: input-start/available then output-available", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "toolcall_start",
          contentIndex: 0,
          partial: {
            content: [{ type: "toolCall", id: "call_1", name: "mcp__platform__search_operations" }],
          },
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            id: "call_1",
            name: "mcp__platform__search_operations",
            arguments: { q: "x" },
          },
          partial: {},
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "mcp__platform__search_operations",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      },
    ]);

    expect(chunks).toContainEqual({
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "search_operations",
    });
    expect(chunks).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "search_operations",
      input: { q: "x" },
    });
    expect(chunks).toContainEqual({
      type: "tool-output-available",
      toolCallId: "call_1",
      output: { content: [{ type: "text", text: "ok" }] },
    });
  });

  it("strips `details` from the tool output — the wire carries the model channel + typed offer", () => {
    // A Pi result carries the payload twice: `content[0].text` (what the model
    // reads) and `details` (Pi's in-memory UI channel, which nothing here
    // reads). Forwarding both persisted and re-uploaded every tool output at
    // twice its size. Everything BUT `details` must survive untouched.
    const content = [{ type: "text", text: JSON.stringify({ id: "run_1", status: "success" }) }];
    const connectOffer = { connect_url: "https://app/api/integrations/connect/start?token=t" };
    const { chunks } = run([
      {
        type: "tool_execution_end",
        toolCallId: "call_3",
        toolName: "invoke_operation",
        result: { content, details: { id: "run_1", status: "success" }, connectOffer },
        isError: false,
      },
    ]);

    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "call_3", output: { content, connectOffer } },
    ]);
    // Negative control, stated explicitly: the key is absent, not `undefined`.
    const output = (chunks[0] as { output: Record<string, unknown> }).output;
    expect(Object.keys(output)).toEqual(["content", "connectOffer"]);
    expect("details" in output).toBe(false);
  });

  it("passes a non-object tool output through unchanged", () => {
    const { chunks } = run([
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "t",
        result: "plain",
        isError: false,
      },
      {
        type: "tool_execution_end",
        toolCallId: "d",
        toolName: "t",
        result: undefined,
        isError: false,
      },
    ]);
    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "c", output: "plain" },
      { type: "tool-output-available", toolCallId: "d", output: null },
    ]);
  });

  it("fires onFirstModelEvent once, on the first ASSISTANT message_start only", () => {
    // The user echo's `message_start` fires at `prompt()`; the assistant's is
    // pi-ai's `start`, pushed once the provider answered. Only the latter is a
    // model event, and only the first one is the turn's time-to-first-response.
    let fired = 0;
    const mapper = new PiChatUiStreamMapper({ onFirstModelEvent: () => (fired += 1) });
    mapper.map({ type: "message_start", message: { role: "user" } });
    expect(fired).toBe(0);
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    expect(fired).toBe(1);
    mapper.map({ type: "message_start", message: { role: "toolResult" } });
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    expect(fired).toBe(1);
  });

  it("emits tool-output-error for a failed tool execution", () => {
    const { chunks } = run([
      {
        type: "tool_execution_end",
        toolCallId: "call_2",
        toolName: "invoke_operation",
        result: { content: [{ type: "text", text: "boom" }] },
        isError: true,
      },
    ]);
    expect(chunks).toEqual([
      { type: "tool-output-error", toolCallId: "call_2", errorText: "boom" },
    ]);
  });

  it("accumulates usage + cost and reports the finish reason", () => {
    const { mapper } = run([
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 165,
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
          },
        },
      },
    ]);
    const meta = mapper.result();
    expect(meta.usage.input).toBe(100);
    expect(meta.usage.output).toBe(50);
    expect(meta.usage.cacheRead).toBe(10);
    expect(meta.usage.cacheWrite).toBe(5);
    // pi-ai's own per-bucket cost rides through on `usage.cost` (informational).
    // The terminal meta exposes NO `costUsd`: billing is computed by the ledger
    // writer from these token counts + the model's catalog rates.
    expect(meta.usage.cost.total).toBeCloseTo(0.3, 6);
    expect(meta).not.toHaveProperty("costUsd");
    expect(meta.finishReason).toBe("tool-calls");
  });

  it("captures a terminal error turn's message + error finish reason", () => {
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 500" },
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("error");
    expect(meta.errorText).toBe("upstream 500");
  });

  it("captures a run failure that only rides turn_end (no message_end)", () => {
    // pi-agent-core's handleRunFailure path: tool exception / context overflow
    // ends the run via turn_end + agent_end without any message_end.
    const { mapper } = run([
      { type: "message_start", message: {} },
      {
        type: "turn_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "tool exploded" },
        toolResults: [],
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("error");
    expect(meta.errorText).toBe("tool exploded");
  });

  it("captures a run failure carried by agent_end's message list", () => {
    const { mapper } = run([
      { type: "message_start", message: {} },
      {
        type: "agent_end",
        messages: [
          { role: "user" },
          { role: "assistant", stopReason: "error", errorMessage: "context overflow" },
        ],
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("error");
    expect(meta.errorText).toBe("context overflow");
  });

  it("retires a failure a later model call recovered from", () => {
    // pi retries inside one turn. A 503 followed by a clean call is no longer
    // the turn's cause — leaving it standing made a turn that later died of the
    // wall-clock deadline report a cause that no longer applied.
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
      },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("stop");
    expect(meta.errorText).toBeUndefined();
  });

  it("retires it across the whole pi auto-retry shape, agent_end included", () => {
    // The real event sequence for one chat turn that pi retried once (chat runs
    // with `retry: { enabled: true, maxRetries: 1 }`). Each internal run closes
    // with its OWN turn_end + agent_end, and agent_end replays that run's
    // message list — so the retired failure must not come back on the way out.
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
      },
      {
        type: "turn_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
        toolResults: [],
      },
      {
        type: "agent_end",
        messages: [
          { role: "user" },
          { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
        ],
      },
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
      { type: "turn_end", message: { role: "assistant", stopReason: "stop" }, toolResults: [] },
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("stop");
    expect(meta.errorText).toBeUndefined();
  });

  it("reads agent_end's verdict off the LAST assistant message, not the whole list", () => {
    // Same invariant the runner states for `getTerminalError` and pi itself
    // uses to decide a retry: an errored message followed by a clean one is a
    // recovery, whatever order the list happens to carry them in. Capturing
    // every entry would resurrect the failure from inside a single event.
    const { mapper } = run([
      {
        type: "agent_end",
        messages: [
          { role: "user" },
          { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
          { role: "assistant", stopReason: "stop" },
          { role: "toolResult" },
        ],
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).not.toBe("error");
    expect(meta.errorText).toBeUndefined();
  });

  it("keeps a failure the turn was cut on (aborted settles nothing)", () => {
    // Stop / deadline abort mid-flight: the last call decided nothing, so the
    // earlier failure is still the last thing that went wrong and must reach
    // the user — this is exactly the deadline-with-a-cause turn.
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: "upstream 503" },
      },
      { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("other");
    expect(meta.errorText).toBe("upstream 503");
  });

  it("does not flag an explicit stop (aborted) as an error", () => {
    const { mapper } = run([
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "aborted", errorMessage: "Aborted" },
      },
    ]);
    const meta = mapper.result();
    expect(meta.finishReason).toBe("other");
    expect(meta.errorText).toBeUndefined();
  });

  it("maps thinking deltas to reasoning-* chunks", () => {
    const { chunks } = run([
      { type: "message_start", message: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "hmm",
          partial: {},
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_end",
          contentIndex: 0,
          content: "hmm",
          partial: {},
        },
      },
    ]);
    expect(chunks).toContainEqual({ type: "reasoning-start", id: "1-0" });
    expect(chunks).toContainEqual({ type: "reasoning-delta", id: "1-0", delta: "hmm" });
    expect(chunks).toContainEqual({ type: "reasoning-end", id: "1-0" });
  });

  it("ignores unknown session events (forward-compat catch-all)", () => {
    const { chunks } = run([{ type: "queue_update", steering: [], followUp: [] }]);
    expect(chunks).toEqual([]);
  });
});

describe("PiChatUiStreamMapper — step counting and block ids", () => {
  it("counts model calls only — not the user echo, not tool results", () => {
    const mapper = new PiChatUiStreamMapper();
    // Pi emits message_start/message_end for the prompt and for every tool
    // result too; counting those made `stepCount` several times the real
    // number of model calls.
    mapper.map({ type: "message_start", message: { role: "user" } });
    mapper.map({ type: "message_end", message: { role: "user" } });
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    mapper.map({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
    mapper.map({ type: "message_start", message: { role: "toolResult" } });
    mapper.map({ type: "message_end", message: { role: "toolResult" } });
    mapper.map({ type: "message_start", message: { role: "assistant" } });
    mapper.map({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });

    expect(mapper.stepCount()).toBe(2);
  });

  it("keeps content-block ids unique across interleaved messages", () => {
    const mapper = new PiChatUiStreamMapper();
    const ids: string[] = [];
    for (const role of ["assistant", "toolResult", "assistant"]) {
      mapper.map({ type: "message_start", message: { role } });
      const chunks = mapper.map({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
      });
      for (const c of chunks) if (c.type === "text-start") ids.push(c.id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});
