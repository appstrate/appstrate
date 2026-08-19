// SPDX-License-Identifier: Apache-2.0

/**
 * The ai-sdk chat path's wall-clock ceiling, end to end.
 *
 * `turnDeadlineAt` has always been handed to every child call as its budget
 * (`run_and_wait` refuses a launch that would outlive it), but on this path
 * nothing ever ENFORCED it: no timer, no abort. A turn past the ceiling kept
 * generating with every remaining step answering "relaunch next turn", and a run
 * that outlived `deadline − 45 s` was orphaned in silence — the session's
 * `active_stream_id` was still set, so orphan reconciliation took its skip
 * branch and never retried.
 *
 * These tests drive the REAL `streamText` from ai@7 with a mock model through
 * the production closure helpers and assert the three properties that make a
 * deadline-killed turn indistinguishable (to the client and to persistence) from
 * the Pi engine's:
 *
 *   1. a REAL text part is persisted — `readUIMessageStream` assembles it into
 *      the message, which an `error` chunk (transient) never would;
 *   2. the turn metadata reports `finishReason: "deadline"` — ai@7 publishes NO
 *      `finish` part on an abort, so the closure stream synthesizes it;
 *   3. a genuine engine error still wins over the deadline.
 *
 * Plus the timer invariant: the armed ceiling must not outlive its turn.
 */

import { describe, expect, it } from "bun:test";
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import {
  CHAT_MAX_STEPS,
  CHAT_TURN_DEADLINE_MS,
  mergeTurnMetadata,
  turnMetadataFromMessage,
  type ChatMessageMetadata,
  type ChatTurnFinishReason,
} from "@appstrate/core/chat-turn-metadata";
import { armTurnDeadline, createTurnClosureStream } from "../src/chat-stream.ts";
import { ChatTurnDeadlineError, turnDeadlineNoticeText } from "../src/turn-closure.ts";
import {
  classifyClientTurnError,
  clientTurnErrorForCategory,
  clientTurnErrorFromMarker,
  clientTurnErrorMarker,
} from "../src/turn-error.ts";

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

/** Stand-in for the handler's `buildTurnMetadata` (same shape, fixed counters). */
function buildMetadata(
  finishReason: ChatTurnFinishReason,
  errorText?: string,
): ChatMessageMetadata {
  const classified =
    finishReason === "error"
      ? (clientTurnErrorFromMarker(errorText) ?? clientTurnErrorForCategory("unknown"))
      : undefined;
  return mergeTurnMetadata(undefined, {
    engine: "ai-sdk",
    finishReason,
    ...(classified
      ? { errorCategory: classified.category, errorRetryable: classified.retryable }
      : {}),
    stepCount: 1,
    maxSteps: CHAT_MAX_STEPS,
    maxStepsReached: false,
  });
}

/**
 * A model stream that emits some text and then STALLS, so the turn is still
 * generating when the ceiling fires — the audited shape (a long tool wait).
 *
 * On abort it fails the way a real provider does: the underlying `fetch` throws
 * a `DOMException` named `AbortError`, whatever the signal's reason. That is
 * what makes ai@7 take its abort branch (emit an `abort` chunk, publish NO
 * `finish`) rather than surfacing an error.
 */
function stallingStream(
  text: string,
  signal: AbortSignal | undefined,
): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  return {
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: "t1" });
        controller.enqueue({ type: "text-delta", id: "t1", delta: text });
        controller.enqueue({ type: "text-end", id: "t1" });
        // Never closes on its own: the turn hangs until it is aborted.
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    }),
  };
}

/** A model stream that fails — a genuine engine error, not a truncation. */
function erroringStream(): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "error", error: new Error("upstream exploded") },
        { type: "finish", finishReason: { unified: "error" }, usage: ZERO_USAGE },
      ],
    }),
  };
}

function nominalStream(text: string): { stream: ReadableStream<LanguageModelV3StreamPart> } {
  return {
    stream: simulateReadableStream<LanguageModelV3StreamPart>({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop" }, usage: ZERO_USAGE },
      ],
    }),
  };
}

/**
 * Run one turn through the exact production assembly (`streamText` →
 * `toUIMessageStream` → `createTurnClosureStream`) and return every chunk the
 * client would receive.
 */
async function runTurn(options: {
  doStream: (signal: AbortSignal | undefined) => {
    stream: ReadableStream<LanguageModelV3StreamPart>;
  };
  /** Fires the ceiling this many ms after the turn starts (omit = never). */
  deadlineInMs?: number;
  /** Aborts with an untagged reason (an explicit user stop). */
  stopInMs?: number;
}): Promise<UIMessageChunk[]> {
  const modelMessages = await convertToModelMessages([
    { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
  ] satisfies UIMessage[]);

  const generation = new AbortController();
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => options.doStream(abortSignal),
  });
  const result = streamText({ model, messages: modelMessages, abortSignal: generation.signal });

  // The production wiring: the ceiling owns the abort, and the closure stream
  // reads the reason back off the armed handle (never off `signal.reason`).
  const turnDeadline =
    options.deadlineInMs === undefined
      ? undefined
      : armTurnDeadline(generation, Date.now() + options.deadlineInMs);
  const stopReason = new Error("stopped by user");
  if (options.stopInMs !== undefined) {
    setTimeout(() => generation.abort(stopReason), options.stopInMs);
  }

  const chunks: UIMessageChunk[] = [];
  try {
    const stream = result
      .toUIMessageStream({
        onError: (err) => clientTurnErrorMarker(classifyClientTurnError(err)),
        generateMessageId: () => "assistant-1",
        messageMetadata: ({ part }) =>
          part.type === "finish" ? buildMetadata(part.finishReason ?? "unknown") : undefined,
      })
      .pipeThrough(
        createTurnClosureStream({
          signal: generation.signal,
          ...(turnDeadline ? { abortReason: () => turnDeadline.abortReason() } : {}),
          buildMetadata,
          newId: () => "deadline-notice",
        }),
      );
    for await (const chunk of stream) chunks.push(chunk);
  } finally {
    turnDeadline?.disarm();
  }
  return chunks;
}

/** Assemble the chunks the way the persist drain does (`stream-parse.ts`). */
async function assembleMessage(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
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

describe("ai-sdk turn deadline", () => {
  it("closes a deadline-killed turn with a persisted text part and finishReason 'deadline'", async () => {
    const chunks = await runTurn({
      doStream: (signal) => stallingStream("je lance la compilation…", signal),
      deadlineInMs: 30,
    });

    // ai@7 answers the abort with an `abort` chunk and NO `finish` part — the
    // exact reason the turn used to end with nothing to show for itself.
    expect(chunks.some((c) => c.type === "abort")).toBe(true);

    // (1) The notice is a REAL text part, not a transient `error` chunk.
    const notice = chunks.filter((c) => "id" in c && c.id === "deadline-notice");
    expect(notice.map((c) => c.type)).toEqual(["text-start", "text-delta", "text-end"]);
    expect(chunks.some((c) => c.type === "error")).toBe(false);

    // (2) The synthesized finish carries the deadline reason.
    const finish = chunks.filter((c) => c.type === "finish");
    expect(finish.length).toBe(1);

    // Both survive assembly — this is what actually gets persisted.
    const message = await assembleMessage(chunks);
    const text = (message?.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    expect(text).toContain("je lance la compilation…");
    expect(text).toContain(turnDeadlineNoticeText(CHAT_TURN_DEADLINE_MS));
    expect(turnMetadataFromMessage(message)?.finishReason).toBe("deadline");
  });

  it("leaves a turn that finished on its own untouched", async () => {
    const chunks = await runTurn({ doStream: () => nominalStream("all done") });

    expect(chunks.some((c) => "id" in c && c.id === "deadline-notice")).toBe(false);
    expect(chunks.filter((c) => c.type === "finish").length).toBe(1);

    const message = await assembleMessage(chunks);
    expect(turnMetadataFromMessage(message)?.finishReason).toBe("stop");
  });

  it("keeps a genuine engine error visible instead of claiming a deadline", async () => {
    const chunks = await runTurn({ doStream: () => erroringStream(), deadlineInMs: 30 });

    expect(chunks.some((c) => c.type === "error")).toBe(true);
    expect(chunks.some((c) => "id" in c && c.id === "deadline-notice")).toBe(false);

    const message = await assembleMessage(chunks);
    expect(turnMetadataFromMessage(message)?.finishReason).not.toBe("deadline");
    expect(turnMetadataFromMessage(message)).toMatchObject({
      finishReason: "error",
      errorCategory: "unknown",
      errorRetryable: true,
    });
  });

  it("does not mistake an explicit user stop for a deadline", async () => {
    const chunks = await runTurn({
      doStream: (signal) => stallingStream("working…", signal),
      stopInMs: 30,
    });

    expect(chunks.some((c) => c.type === "abort")).toBe(true);
    expect(chunks.some((c) => "id" in c && c.id === "deadline-notice")).toBe(false);
  });
});

describe("createTurnClosureStream", () => {
  /** Feed a chunk list through the closure stream and collect the output. */
  async function through(input: UIMessageChunk[], signal: AbortSignal): Promise<UIMessageChunk[]> {
    const source = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of input) controller.enqueue(chunk);
        controller.close();
      },
    });
    const out: UIMessageChunk[] = [];
    const reader = source
      .pipeThrough(
        createTurnClosureStream({ signal, buildMetadata, newId: () => "deadline-notice" }),
      )
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  }

  it("does not overwrite a turn that already published its own finish", async () => {
    // Race: the ceiling fires just after the SDK enqueued its `finish`. The turn
    // completed — claiming a truncation would be a lie.
    const controller = new AbortController();
    controller.abort(new ChatTurnDeadlineError(CHAT_TURN_DEADLINE_MS));

    const out = await through(
      [{ type: "start", messageId: "a1" }, { type: "finish" }],
      controller.signal,
    );

    expect(out.filter((c) => c.type === "finish").length).toBe(1);
    expect(out.some((c) => "id" in c && c.id === "deadline-notice")).toBe(false);
  });

  it("is inert when the turn was never aborted", async () => {
    const controller = new AbortController();
    const input: UIMessageChunk[] = [{ type: "start", messageId: "a1" }];
    expect(await through(input, controller.signal)).toEqual(input);
  });

  it("synthesizes a persisted finish for an error-only stream", async () => {
    const controller = new AbortController();
    const out = await through(
      [
        { type: "start", messageId: "a1" },
        {
          type: "error",
          errorText: clientTurnErrorMarker(clientTurnErrorForCategory("upstream_unavailable")),
        },
      ],
      controller.signal,
    );

    expect(out.filter((c) => c.type === "finish")).toHaveLength(1);
    const message = await assembleMessage(out);
    expect(message?.id).toBe("a1");
    expect(turnMetadataFromMessage(message)).toMatchObject({
      finishReason: "error",
      errorCategory: "upstream_unavailable",
      errorRetryable: true,
    });
  });
});

describe("armTurnDeadline", () => {
  it("aborts the turn at the ceiling with a tagged reason", async () => {
    const controller = new AbortController();
    const armed = armTurnDeadline(controller, Date.now() + 5);

    await new Promise((r) => setTimeout(r, 40));

    expect(controller.signal.aborted).toBe(true);
    // Read off the handle, NOT `signal.reason`: Bun 1.3 can collect a reason
    // whose only holder was the timer callback, which would silently downgrade
    // the ceiling to an untagged stop.
    expect(armed.abortReason()).toBeInstanceOf(ChatTurnDeadlineError);
  });

  it("does not outlive the turn — disarming cancels the abort", async () => {
    const controller = new AbortController();
    const armed = armTurnDeadline(controller, Date.now() + 5);
    armed.disarm();

    await new Promise((r) => setTimeout(r, 40));

    expect(controller.signal.aborted).toBe(false);
  });

  it("reports an explicit stop as-is (the ceiling never fired)", () => {
    const controller = new AbortController();
    const armed = armTurnDeadline(controller, Date.now() + 60_000);
    const stop = new Error("stopped by user");
    controller.abort(stop);
    armed.disarm();

    expect(armed.abortReason()).toBe(stop);
  });
});
