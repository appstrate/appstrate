// SPDX-License-Identifier: Apache-2.0

/**
 * `src/pi-chat/pi-turn-closure.ts` — how a Pi chat turn ends and what the user
 * is told about it: telling a deadline from an explicit stop, the notice a
 * truncated turn writes, and `closePiTurn`, the single emitter both of the
 * engine's exits (its loop returning, and an exception escaping) go through.
 */

import { describe, expect, it } from "bun:test";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import {
  ChatTurnDeadlineError,
  closePiTurn,
  isChatTurnDeadline,
  resolveTurnClosure,
  turnDeadlineNoticeText,
  turnNoticeChunks,
} from "../src/pi-chat/pi-turn-closure.ts";

const TEN_MINUTES = 10 * 60_000;

async function assemble(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last;
}

describe("turn abort causes", () => {
  it("recognises the deadline reason", () => {
    expect(isChatTurnDeadline(new ChatTurnDeadlineError(TEN_MINUTES))).toBe(true);
  });

  it("does not mistake an explicit stop for a deadline", () => {
    expect(isChatTurnDeadline(new Error("stopped by user"))).toBe(false);
    expect(isChatTurnDeadline("AbortError")).toBe(false);
    expect(isChatTurnDeadline(undefined)).toBe(false);
  });
});

describe("resolveTurnClosure", () => {
  it("reports a deadline-killed turn as finishReason:'deadline'", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new ChatTurnDeadlineError(TEN_MINUTES),
      // What the incident produced: the last completed step was a tool call.
      finishReason: "tool-calls",
    });
    expect(closure).toEqual({ finishReason: "deadline", deadlineReached: true });
  });

  it("leaves an explicit stop untouched (distinct path)", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new Error("stopped by user"),
      finishReason: "tool-calls",
    });
    expect(closure).toEqual({ finishReason: "tool-calls", deadlineReached: false });
  });

  it("leaves a turn that ended on its own untouched", () => {
    const closure = resolveTurnClosure({
      aborted: false,
      abortReason: undefined,
      finishReason: "stop",
    });
    expect(closure).toEqual({ finishReason: "stop", deadlineReached: false });
  });

  it("keeps a genuine engine error visible instead of claiming a deadline", () => {
    const closure = resolveTurnClosure({
      aborted: true,
      abortReason: new ChatTurnDeadlineError(TEN_MINUTES),
      finishReason: "error",
    });
    expect(closure).toEqual({ finishReason: "error", deadlineReached: false });
  });
});

describe("deadline notice", () => {
  it("writes a real, non-empty text part (not an error chunk)", () => {
    const chunks = turnNoticeChunks("notice-1", turnDeadlineNoticeText(TEN_MINUTES));
    expect(chunks.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const delta = chunks.find((c) => c.type === "text-delta") as { delta: string };
    expect(delta.delta.length).toBeGreaterThan(0);
  });

  it("states the time limit, the surviving runs, and how to resume", () => {
    const text = turnDeadlineNoticeText(TEN_MINUTES);
    expect(text).toContain("10 minutes");
    expect(text).toContain("arrière-plan");
    expect(text).toContain("message");
  });
});

describe("closePiTurn", () => {
  it("makes a setup failure reconstructable and persists safe error metadata", async () => {
    const chunks = closePiTurn({
      error: new Error("upstream 503 req_public123 leaked detail"),
      finishReason: "error",
      streamStarted: false,
      aborted: false,
      abortReason: undefined,
      stepCount: 0,
      stepCapReached: false,
      lastToolName: "read_file",
      newId: () => "assistant-before-start",
    }).chunks;

    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "error", "finish"]);
    const message = await assemble(chunks);
    expect(message?.id).toBe("assistant-before-start");
    expect(turnMetadataFromMessage(message)).toMatchObject({
      finishReason: "error",
      errorCategory: "upstream_unavailable",
      errorRetryable: true,
      requestId: "req_public123",
      stepCount: 0,
      maxSteps: 16,
      toolStepBudget: 15,
      toolStepBudgetReached: false,
      maxStepsReached: false,
      lastToolName: "read_file",
    });
    expect(JSON.stringify(message)).not.toContain("leaked detail");
  });

  it("finishes a started prompt failure exactly once for reload persistence", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "assistant-after-start" },
      ...closePiTurn({
        error: new Error("rate limit 429"),
        finishReason: "error",
        streamStarted: true,
        aborted: false,
        abortReason: undefined,
        stepCount: 3,
        stepCapReached: false,
        newId: () => "unused",
      }).chunks,
    ];

    expect(chunks.filter((chunk) => chunk.type === "start")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "finish")).toHaveLength(1);
    expect(turnMetadataFromMessage(await assemble(chunks))).toMatchObject({
      finishReason: "error",
      errorCategory: "rate_limited",
      errorRetryable: true,
      stepCount: 3,
    });
  });

  it("preserves deadline semantics when setup aborts before start", async () => {
    const closing = closePiTurn({
      // The caller suppresses the abort's own error: a stop is a normal ending.
      finishReason: "stop",
      streamStarted: false,
      aborted: true,
      abortReason: new ChatTurnDeadlineError(10),
      stepCount: 0,
      stepCapReached: false,
      newId: (() => {
        const ids = ["assistant-deadline", "deadline-notice"];
        return () => ids.shift()!;
      })(),
    });

    expect(closing.deadlineReached).toBe(true);
    expect(closing.chunks.some((chunk) => chunk.type === "error")).toBe(false);
    const message = await assemble(closing.chunks);
    expect(turnMetadataFromMessage(message)?.finishReason).toBe("deadline");
    const text = message?.parts.find((part) => part.type === "text");
    expect(text && "text" in text ? text.text : undefined).toBe(
      turnDeadlineNoticeText(10 * 60_000),
    );
  });

  it("keeps an explicit stop distinct from a failure and a deadline", async () => {
    const closing = closePiTurn({
      finishReason: "stop",
      streamStarted: false,
      aborted: true,
      abortReason: new Error("stopped by user"),
      stepCount: 0,
      stepCapReached: false,
      newId: () => "assistant-stopped",
    });

    expect(closing.deadlineReached).toBe(false);
    expect(closing.chunks.map((chunk) => chunk.type)).toEqual(["start", "finish"]);
    expect(turnMetadataFromMessage(await assemble(closing.chunks))?.finishReason).toBe("stop");
  });

  it("closes the success path with the loop's own finish reason and no start", async () => {
    // What `engine.ts` does when the Pi loop returns normally: the `start` was
    // already written, so no second one is owed, and the model's finish reason
    // flows through untouched.
    const closing = closePiTurn({
      finishReason: "stop",
      streamStarted: true,
      aborted: false,
      abortReason: undefined,
      stepCount: 4,
      stepCapReached: true,
      lastToolName: "run_and_wait",
    });

    expect(closing.chunks.map((chunk) => chunk.type)).toEqual(["finish"]);
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "assistant-ok" },
      ...closing.chunks,
    ];
    expect(turnMetadataFromMessage(await assemble(chunks))).toMatchObject({
      finishReason: "stop",
      stepCount: 4,
      toolStepBudgetReached: true,
      maxStepsReached: true,
      lastToolName: "run_and_wait",
    });
  });

  it("surfaces a model-reported error even though nothing was thrown", async () => {
    // The other success-path shape: the loop ended with `finishReason: "error"`,
    // so the engine hands the model's own error text to the same emitter.
    const closing = closePiTurn({
      error: "unknown model error",
      finishReason: "error",
      streamStarted: true,
      aborted: false,
      abortReason: undefined,
      stepCount: 2,
      stepCapReached: false,
    });

    expect(closing.chunks.map((chunk) => chunk.type)).toEqual(["error", "finish"]);
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "assistant-model-error" },
      ...closing.chunks,
    ];
    expect(turnMetadataFromMessage(await assemble(chunks))).toMatchObject({
      finishReason: "error",
      stepCount: 2,
    });
  });
});
