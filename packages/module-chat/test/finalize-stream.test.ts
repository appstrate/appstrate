// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";
import {
  createInMemoryResumableStreamStore,
  createResumableStreamContext,
  type ResumableStreamContext,
  type ResumableStreamStore,
} from "assistant-stream/resumable";
import { finalizeChatStream } from "../src/finalize-stream.ts";
import { extractAssistantMessage } from "../src/stream-parse.ts";

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

  it("persists the turn's assistant message once, after the user turn", async () => {
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_1" });
      writer.write({ type: "text-start", id: "t1" });
      writer.write({ type: "text-delta", id: "t1", delta: "one" });
      writer.write({ type: "text-end", id: "t1" });
      writer.write({ type: "finish" });
    });

    const saved: { id: string; precedingMessageId: string | null }[] = [];
    let settled!: () => void;
    const done = new Promise<void>((r) => (settled = r));

    const res = await finalizeChatStream({
      engineResponse,
      streamId: crypto.randomUUID(),
      precedingMessageId: "user_1",
      onAssistant: (m, precedingMessageId) => saved.push({ id: m.id, precedingMessageId }),
      onSettled: () => settled(),
    });
    await res.body!.pipeTo(new WritableStream());
    await done;

    // One turn, one assistant row, handed the user message that prompted it.
    expect(saved).toEqual([{ id: "asst_1", precedingMessageId: "user_1" }]);
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
      precedingMessageId: null,
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

/** The real in-memory store, with `append` counted — the record-branch load. */
function countingStore(): { store: ResumableStreamStore; appends: () => number } {
  const inner = createInMemoryResumableStreamStore();
  let appends = 0;
  const store: ResumableStreamStore = {
    ...inner,
    append: async (streamId, chunk) => {
      appends += 1;
      await inner.append(streamId, chunk);
    },
  };
  return { store, appends: () => appends };
}

/** Wait until the producer has finalized the recording (it lags the client by a batch window). */
async function recorded(context: ResumableStreamContext, streamId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await context.status(streamId)) === "streaming") {
    if (Date.now() > deadline) throw new Error("recording never finalized");
    await Bun.sleep(5);
  }
}

function textOf(message: UIMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

describe("finalizeChatStream — record-branch batching", () => {
  it("batches the RECORD branch while the client still gets every chunk", async () => {
    // The producer used to issue one store append per SSE chunk — on Redis,
    // one `GET meta` + one `XADD`/`EXPIRE` pipeline per model token, per turn.
    // 200 chunks ~1 ms apart must land as a handful of appends (one per batch
    // window), while the CLIENT branch is untouched: it reads them one by one.
    const CHUNKS = 200;
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_batch" });
      writer.write({ type: "text-start", id: "t" });
      for (let i = 0; i < CHUNKS; i += 1) {
        writer.write({ type: "text-delta", id: "t", delta: `${i} ` });
        await Bun.sleep(1);
      }
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish" });
    });
    const { store, appends } = countingStore();
    const context = createResumableStreamContext({ store });
    const streamId = crypto.randomUUID();

    const res = await finalizeChatStream({ engineResponse, streamId, resumableContext: context });

    const reader = res.body!.getReader();
    let clientReads = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      clientReads += 1;
    }
    await recorded(context, streamId);

    // Client: chunk-for-chunk with the engine (start + text-start + deltas + …).
    expect(clientReads).toBeGreaterThanOrEqual(CHUNKS);
    // Record: batched. The unbatched producer appends once per chunk, i.e.
    // exactly `clientReads` times; coalescing must cut that by far more than
    // half however slowly the source ticks.
    expect(appends()).toBeGreaterThan(0);
    expect(appends()).toBeLessThan(clientReads / 2);
  });

  it("replays the batched recording to the same assistant message", async () => {
    const text = "the same bytes, fewer appends";
    const engineResponse = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_replay" });
      writer.write({ type: "text-start", id: "t" });
      for (const word of text.split(" ")) {
        writer.write({ type: "text-delta", id: "t", delta: `${word} ` });
        await Bun.sleep(1);
      }
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish" });
    });
    const { store } = countingStore();
    const context = createResumableStreamContext({ store });
    const streamId = crypto.randomUUID();

    let persisted: UIMessage | undefined;
    const res = await finalizeChatStream({
      engineResponse,
      streamId,
      resumableContext: context,
      onAssistant: (m) => {
        persisted = m;
      },
    });
    const client = await extractAssistantMessage(res.body!);
    await recorded(context, streamId);

    const resumed = await context.resume(streamId);
    expect(resumed).not.toBeNull();
    const replayed = await extractAssistantMessage(resumed!);
    expect(textOf(replayed)).toBe(`${text} `);
    expect(replayed).toEqual(client);
    expect(replayed).toEqual(persisted);
  });

  it("replays correctly when chunk boundaries fall INSIDE an SSE frame", async () => {
    // SSE is a byte stream: the engine body may cut a frame anywhere, and the
    // batcher concatenates whatever it is handed. Re-chunk a valid stream into
    // 5-byte slices and batch them 8 bytes at a time, so every recorded entry
    // (and every client read) starts and ends mid-frame. Both readers must
    // reassemble the frames across those boundaries.
    const source = engine(async ({ writer }) => {
      writer.write({ type: "start", messageId: "asst_split" });
      writer.write({ type: "text-start", id: "t" });
      writer.write({ type: "text-delta", id: "t", delta: "split across boundaries" });
      writer.write({ type: "text-end", id: "t" });
      writer.write({ type: "finish", messageMetadata: { appstrate: { turn: { stepCount: 1 } } } });
    });
    const bytes = new Uint8Array(await source.arrayBuffer());
    const sliced = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.byteLength; i += 5) controller.enqueue(bytes.slice(i, i + 5));
        controller.close();
      },
    });
    const engineResponse = new Response(sliced, { headers: source.headers });
    const { store, appends } = countingStore();
    const context = createResumableStreamContext({ store });
    const streamId = crypto.randomUUID();

    const res = await finalizeChatStream({
      engineResponse,
      streamId,
      resumableContext: context,
      recording: { flushBytes: 8, flushIntervalMs: 10_000 },
    });
    const client = await extractAssistantMessage(res.body!);
    await recorded(context, streamId);

    // The recording really was cut inside frames: ~10-byte entries, many of them.
    expect(appends()).toBeGreaterThan(bytes.byteLength / 20);
    const resumed = await context.resume(streamId);
    const replayed = await extractAssistantMessage(resumed!);
    expect(textOf(replayed)).toBe("split across boundaries");
    expect(replayed?.id).toBe("asst_split");
    expect(replayed).toEqual(client);
    expect((replayed as { metadata?: unknown }).metadata).toEqual({
      appstrate: { turn: { stepCount: 1 } },
    });
  });
});
