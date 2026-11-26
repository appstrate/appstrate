// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { formatTurnBudgetNote } from "@appstrate/core/chat-turn-metadata";
import {
  dispatchSpace,
  PiChatUiStreamMapper,
  stripMcpToolPrefix,
} from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Feed a list of pi session events through one mapper, collect all UI chunks. */
function run(events: AgentSessionEvent[]) {
  const mapper = new PiChatUiStreamMapper();
  const chunks = events.flatMap((e) => mapper.map(e));
  return { chunks, mapper };
}

describe("stripMcpToolPrefix", () => {
  it("strips the mcp__<server>__ prefix but keeps inner __", () => {
    expect(stripMcpToolPrefix("mcp__platform__search")).toBe("search");
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
            content: [{ type: "toolCall", id: "call_1", name: "mcp__platform__search" }],
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
            name: "mcp__platform__search",
            arguments: { q: "x" },
          },
          partial: {},
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "mcp__platform__search",
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      },
    ]);

    expect(chunks).toContainEqual({
      type: "tool-input-start",
      toolCallId: "call_1",
      toolName: "search",
    });
    expect(chunks).toContainEqual({
      type: "tool-input-available",
      toolCallId: "call_1",
      toolName: "search",
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
    const connectOffers = [{ connect_url: "https://app/api/integrations/connect/start?token=t" }];
    const { chunks } = run([
      {
        type: "tool_execution_end",
        toolCallId: "call_3",
        toolName: "invoke_operation",
        result: { content, details: { id: "run_1", status: "success" }, connectOffers },
        isError: false,
      },
    ]);

    expect(chunks).toEqual([
      { type: "tool-output-available", toolCallId: "call_3", output: { content, connectOffers } },
    ]);
    // Negative control, stated explicitly: the key is absent, not `undefined`.
    const output = (chunks[0] as { output: Record<string, unknown> }).output;
    expect(Object.keys(output)).toEqual(["content", "connectOffers"]);
    expect("details" in output).toBe(false);
  });

  it("streams only the receipt for a temporary file, including when Pi reports a tool error", () => {
    const receipt = { type: "text", text: "File read for this turn." };
    const end = {
      type: "tool_execution_end" as const,
      toolCallId: "file-1",
      toolName: "call_integration_tool",
      result: {
        content: [{ type: "text", text: "private file contents" }],
        details: {},
        persistedContent: [receipt],
      },
    };
    expect(run([{ ...end, isError: false }]).chunks).toEqual([
      {
        type: "tool-output-available",
        toolCallId: "file-1",
        output: { content: [receipt] },
      },
    ]);
    expect(run([{ ...end, isError: true }]).chunks).toEqual([
      { type: "tool-output-error", toolCallId: "file-1", errorText: receipt.text },
    ]);
  });

  it("leaves the model's turn-budget line out of a tool error's text", () => {
    const budget = formatTurnBudgetNote({ remainingMs: 558_000, stepsUsed: 7 });
    const chunks = run([
      {
        type: "tool_execution_end",
        toolCallId: "gh-1",
        toolName: "call_integration_tool",
        result: {
          content: [
            { type: "text", text: "403 Resource not accessible" },
            { type: "text", text: budget },
          ],
          details: {},
        },
        isError: true,
      },
    ]).chunks;
    expect(chunks).toEqual([
      { type: "tool-output-error", toolCallId: "gh-1", errorText: "403 Resource not accessible" },
    ]);
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

  it("reports a tool-use finish reason", () => {
    const { mapper } = run([
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } },
    ]);
    expect(mapper.result().finishReason).toBe("tool-calls");
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

describe("the space a tool call is stamped with", () => {
  const callEnd = (args: Record<string, unknown>): AgentSessionEvent[] => [
    { type: "message_start", message: {} },
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { id: "call_1", name: "mcp__platform__run_and_wait", arguments: args },
        partial: {},
      },
    } as AgentSessionEvent,
  ];

  const available = (args: Record<string, unknown>, turnSpaces: ReadonlySet<string>) => {
    const mapper = new PiChatUiStreamMapper({ turnSpaces });
    return callEnd(args)
      .flatMap((e) => mapper.map(e))
      .find((c) => c.type === "tool-input-available") as { providerMetadata?: unknown };
  };

  it("rides tool-input-available as providerMetadata.appstrate.spaceId", () => {
    expect(available({ space_id: "spc_o" }, new Set(["spc_o"])).providerMetadata).toEqual({
      appstrate: { spaceId: "spc_o" },
    });
  });

  it("is the named space_id, and nothing for a call naming none", () => {
    expect(dispatchSpace({ space_id: "spc_b" })).toBe("spc_b");
    expect(dispatchSpace({})).toBeUndefined();
    expect("providerMetadata" in available({}, new Set(["spc_o"]))).toBe(false);
  });

  it("stamps nothing for a space outside the turn's, which the call is refused in", () => {
    expect("providerMetadata" in available({ space_id: "spc_x" }, new Set(["spc_o"]))).toBe(false);
  });
});

describe("PiChatUiStreamMapper — the last settled call", () => {
  const usage = (input: number, output: number, cacheRead = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: 0,
    cost: ZERO_COST,
  });
  const start: AgentSessionEvent = { type: "message_start", message: { role: "assistant" } };
  const end = (stopReason: string, u: ReturnType<typeof usage>): AgentSessionEvent => ({
    type: "message_end",
    message: { role: "assistant", stopReason, usage: u },
  });
  const compaction = (summary: string): AgentSessionEvent => ({
    type: "compaction_end",
    result: { summary, firstKeptEntryId: `kept_${summary}`, tokensBefore: 9_000 },
    aborted: false,
  });

  it("keeps the last call's usage, which the turn's summed usage cannot give back", () => {
    const { mapper } = run([
      end("toolUse", usage(1_000, 200, 9_000)),
      end("stop", usage(1_500, 300)),
    ]);
    expect(mapper.result().lastSettledUsage).toEqual(usage(1_500, 300));
  });

  it("skips an aborted or failed call, which measured nothing", () => {
    const { mapper } = run([
      end("stop", usage(4_000, 100)),
      end("aborted", usage(9, 0)),
      end("error", usage(9, 0)),
    ]);
    expect(mapper.result().lastSettledUsage).toEqual(usage(4_000, 100));
    expect("lastSettledUsage" in run([end("error", usage(9, 0))]).mapper.result()).toBe(false);
  });

  it("keeps the summary made at any point of the turn, the last one winning", () => {
    expect(
      run([compaction("s1"), start, end("stop", usage(10, 5))]).mapper.result().compaction,
    ).toEqual({ summary: "s1", firstKeptEntryId: "kept_s1", tokensBefore: 9_000 });
    expect(
      run([compaction("s1"), start, end("stop", usage(10, 5)), compaction("s2")]).mapper.result()
        .compaction?.summary,
    ).toBe("s2");
  });

  it("keeps the settled context measure across summary events", () => {
    const summarized: AgentSessionEvent = {
      type: "compaction_end",
      result: { summary: "s", firstKeptEntryId: "k", tokensBefore: 1, usage: usage(7_000, 400) },
      aborted: false,
    };
    const aborted: AgentSessionEvent = {
      type: "compaction_end",
      result: { summary: "s", firstKeptEntryId: "k", tokensBefore: 1, usage: usage(9, 9) },
      aborted: true,
    };
    const result = run([
      start,
      end("stop", usage(1_000, 100)),
      summarized,
      aborted,
    ]).mapper.result();
    expect(result.lastSettledUsage).toEqual(usage(1_000, 100));
  });

  it("keeps Pi's post-summary estimate only while no call settled after the summary", () => {
    const summarized = (after: number): AgentSessionEvent => ({
      type: "compaction_end",
      result: { summary: "s", firstKeptEntryId: "k", tokensBefore: 1, estimatedTokensAfter: after },
      aborted: false,
    });
    const last = run([start, end("stop", usage(190_000, 100)), summarized(40_000)]).mapper.result();
    expect(last.contextAfterCompaction).toBe(40_000);
    expect(last.lastSettledUsage).toEqual(usage(190_000, 100));
    const followed = run([
      summarized(40_000),
      start,
      end("stop", usage(50_000, 100)),
    ]).mapper.result();
    expect(followed).not.toHaveProperty("contextAfterCompaction");
  });

  it("ignores an aborted or failed summary", () => {
    const aborted: AgentSessionEvent = { type: "compaction_end", result: undefined, aborted: true };
    const failed: AgentSessionEvent = { type: "compaction_end", result: undefined, aborted: false };
    expect(run([aborted, failed, start]).mapper.result()).not.toHaveProperty("compaction");
    expect(run([compaction("s1"), aborted]).mapper.result().compaction?.summary).toBe("s1");
  });
});
