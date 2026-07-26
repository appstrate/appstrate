// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ResumableStreamContext } from "assistant-stream/resumable";
import { finalizeChatStream } from "../src/finalize-stream.ts";
import { getResumableContext } from "../src/resumable.ts";
import { extractAssistantMessages } from "../src/stream-parse.ts";

/**
 * The live-resume guarantee: a turn's bytes are recorded under its stream id so a
 * reloaded client can reconnect to them. Exercises the real finalize → resumable
 * (in-memory store) → resume path; no model, DB, or browser.
 */
function engine(text: string): Response {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: "asst_r" });
        writer.write({ type: "text-start", id: "t" });
        writer.write({ type: "text-delta", id: "t", delta: text });
        writer.write({ type: "text-end", id: "t" });
        writer.write({ type: "finish" });
      },
    }),
  });
}

describe("resumable streams", () => {
  it("records a turn so resume(streamId) replays it", async () => {
    const streamId = crypto.randomUUID();
    const res = await finalizeChatStream({ engineResponse: engine("hello world"), streamId });
    // Drive the client branch to completion (as a connected client would).
    await res.body!.pipeTo(new WritableStream());

    const resumed = await getResumableContext().resume(streamId);
    expect(resumed).not.toBeNull();
    const [msg] = await extractAssistantMessages(resumed!);
    expect(msg?.role).toBe("assistant");
    const text = (msg?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text).toBe("hello world");
  });

  it("resume() returns null for an unknown stream id", async () => {
    expect(await getResumableContext().resume(crypto.randomUUID())).toBeNull();
  });

  /**
   * The nominal path must NOT round-trip through the store: `context.run()` hands
   * back a store reader even to the producer, and serving that to the connected
   * client made every chat turn read its own bytes back out of Redis (100ms poll
   * loop for the whole turn). The client gets its own tee branch; the store reader
   * is released. Recording is unaffected — that is what resume reads.
   */
  it("serves the producer its own bytes and releases the store read-back", async () => {
    const decoder = new TextDecoder();
    let readBackCancelled = false;
    const recorded: string[] = [];
    let recordingDone!: () => void;
    const recording = new Promise<void>((r) => (recordingDone = r));

    // Stand-in for the real context: records like the library's producer task,
    // and returns a read-back stream carrying a sentinel the client must never see.
    const fakeContext: ResumableStreamContext = {
      run: async (_streamId, makeStream) => {
        void (async () => {
          const reader = makeStream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            recorded.push(decoder.decode(value, { stream: true }));
          }
          recordingDone();
        })();
        return new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode("STORE-READ-BACK")),
          cancel: () => {
            readBackCancelled = true;
          },
        });
      },
      resume: async () => null,
      requireResume: () => Promise.reject(new Error("unused")),
      status: async () => "missing",
      delete: async () => {},
    };

    const res = await finalizeChatStream({
      engineResponse: engine("live tokens"),
      streamId: crypto.randomUUID(),
      resumableContext: fakeContext,
    });
    const body = await new Response(res.body).text();

    // The client read the engine stream directly…
    expect(body).toContain("live tokens");
    expect(body).not.toContain("STORE-READ-BACK");
    // …and the producer's store reader was released instead of left polling.
    expect(readBackCancelled).toBe(true);
    // Recording still happened — resume depends on it.
    await recording;
    expect(recorded.join("")).toContain("live tokens");
  });
});
