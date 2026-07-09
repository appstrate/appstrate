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
        return m.id;
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

  it("persists every message of a multi-message turn, in order, with correct parent chaining", async () => {
    // The pi-chat engine can emit several assistant messages in one turn.
    // Each must be persisted, chained onto the previous (the first onto the user
    // turn) — earlier ones must not be dropped.
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_1" });
      writer.write({ type: "text-start", id: "t1" });
      writer.write({ type: "text-delta", id: "t1", delta: "one" });
      writer.write({ type: "text-end", id: "t1" });
      writer.write({ type: "finish" });
      writer.write({ type: "start", messageId: "asst_2" });
      writer.write({ type: "text-start", id: "t2" });
      writer.write({ type: "text-delta", id: "t2", delta: "two" });
      writer.write({ type: "text-end", id: "t2" });
      writer.write({ type: "finish" });
    });

    const saved: { id: string; parentId: string | null }[] = [];
    let settled!: () => void;
    const done = new Promise<void>((r) => (settled = r));

    const res = await finalizeChatStream({
      engineResponse,
      streamId: crypto.randomUUID(),
      parentId: "user_1",
      onAssistant: (m, parentId) => {
        saved.push({ id: m.id, parentId });
        return m.id; // the id the row is stored under → the next message's parent
      },
      onSettled: () => settled(),
    });
    await res.body!.pipeTo(new WritableStream());
    await done;

    expect(saved).toEqual([
      { id: "asst_1", parentId: "user_1" }, // first chains onto the user turn
      { id: "asst_2", parentId: "asst_1" }, // second chains onto the first assistant
    ]);
  });

  it("retries the persist once when the first attempt fails, then saves the turn", async () => {
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_retry" });
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: "saved on retry" });
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish" });
    });

    let attempts = 0;
    let saved: UIMessage | undefined;
    let settled!: () => void;
    const done = new Promise<void>((r) => (settled = r));

    const res = await finalizeChatStream({
      engineResponse,
      streamId: crypto.randomUUID(),
      parentId: null,
      onAssistant: (m) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient DB error");
        saved = m;
        return m.id;
      },
      onSettled: () => settled(),
    });
    await res.body!.pipeTo(new WritableStream());
    await done;

    expect(attempts).toBe(2); // failed once, retried once
    expect(saved?.id).toBe("asst_retry");
  });
});
