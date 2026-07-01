// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
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
});
