// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";
import { ChatTurnDeadlineError, turnDeadlineNoticeText } from "../src/turn-closure.ts";
import { subscriptionFailureChunks } from "../src/pi-chat/failure-closure.ts";

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

describe("subscriptionFailureChunks", () => {
  it("makes a setup failure reconstructable and persists safe error metadata", async () => {
    const chunks = subscriptionFailureChunks({
      error: new Error("upstream 503 req_public123 leaked detail"),
      streamStarted: false,
      aborted: false,
      abortReason: undefined,
      stepCount: 0,
      stepCapReached: false,
      newId: () => "assistant-before-start",
    });

    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "error", "finish"]);
    const message = await assemble(chunks);
    expect(message?.id).toBe("assistant-before-start");
    expect(turnMetadataFromMessage(message)).toMatchObject({
      engine: "subscription",
      finishReason: "error",
      errorCategory: "upstream_unavailable",
      errorRetryable: true,
      requestId: "req_public123",
      stepCount: 0,
    });
    expect(JSON.stringify(message)).not.toContain("leaked detail");
  });

  it("finishes a started prompt failure exactly once for reload persistence", async () => {
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "assistant-after-start" },
      ...subscriptionFailureChunks({
        error: new Error("rate limit 429"),
        streamStarted: true,
        aborted: false,
        abortReason: undefined,
        stepCount: 3,
        stepCapReached: false,
        newId: () => "unused",
      }),
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
    const chunks = subscriptionFailureChunks({
      error: new DOMException("aborted", "AbortError"),
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

    expect(chunks.some((chunk) => chunk.type === "error")).toBe(false);
    const message = await assemble(chunks);
    expect(turnMetadataFromMessage(message)?.finishReason).toBe("deadline");
    const text = message?.parts.find((part) => part.type === "text");
    expect(text && "text" in text ? text.text : undefined).toBe(
      turnDeadlineNoticeText(10 * 60_000),
    );
  });

  it("keeps an explicit stop distinct from a failure and a deadline", async () => {
    const chunks = subscriptionFailureChunks({
      error: new DOMException("aborted", "AbortError"),
      streamStarted: false,
      aborted: true,
      abortReason: new Error("stopped by user"),
      stepCount: 0,
      stepCapReached: false,
      newId: () => "assistant-stopped",
    });

    expect(chunks.map((chunk) => chunk.type)).toEqual(["start", "finish"]);
    expect(turnMetadataFromMessage(await assemble(chunks))?.finishReason).toBe("stop");
  });
});
