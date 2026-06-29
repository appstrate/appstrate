// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import { finalizeChatStream } from "../src/finalize-stream.ts";

/**
 * The core robustness guarantee: generation is decoupled from the client
 * connection. Even when the client disconnects mid-stream, the resumable
 * producer + persist task drive the engine stream to completion server-side, so
 * the assistant turn is still persisted. These exercise the real tee +
 * resumable (in-memory store) + SSE-parse path — no model, DB, or browser.
 */
function engine(execute: Parameters<typeof createUIMessageStream>[0]["execute"]): Response {
  return createUIMessageStreamResponse({ stream: createUIMessageStream({ execute }) });
}

describe("finalizeChatStream — disconnect survival", () => {
  it("persists the assistant turn even when the client disconnects mid-stream", async () => {
    let resolve!: (m: UIMessage) => void;
    const persisted = new Promise<UIMessage>((r) => (resolve = r));

    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_x" });
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: "partial" });
      // Work continues after the client has gone.
      await new Promise((r) => setTimeout(r, 20));
      writer.write({ type: "text-delta", id: "t", delta: " then more" });
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish" });
    });

    const res = await finalizeChatStream({
      engineResponse,
      streamId: crypto.randomUUID(),
      onAssistant: (m) => {
        resolve(m);
      },
    });

    // Client reads one chunk, then disconnects (cancels the stream).
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    // Despite the disconnect, the full assistant turn is still persisted.
    const message = await persisted;
    expect(message.id).toBe("asst_x");
    const text = (message.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("partial then more");
  });

  it("drains the stream when there is no session to persist into", async () => {
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "a" });
      writer.write({ type: "finish" });
    });
    const res = await finalizeChatStream({ engineResponse, streamId: crypto.randomUUID() });
    await res.body!.cancel(); // immediate disconnect
    // No throw; the persist branch still drains the source to completion.
    expect(res.status).toBe(200);
  });
});
