// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure(-ish) metering helpers shared by the LLM-proxy core
 * and the subscription gateways: cost derivation and the streaming usage tap.
 *
 * `recordProxyUsage` (the DB-writing half) is exercised by the route-level
 * integration tests; here we cover the cost math and the SSE frame
 * reassembly/retention in isolation.
 */

import { describe, it, expect } from "bun:test";
import {
  computeCostUsd,
  tapSseUsage,
  guardSseTeardown,
  forwardMeteredResponse,
  type MeteredForwardContext,
} from "../../src/services/llm-proxy/metering.ts";
import { anthropicMessagesAdapter } from "../../src/services/llm-proxy/anthropic.ts";
import type { UpstreamUsage } from "../../src/services/llm-proxy/types.ts";
import type { ResolvedModel } from "../../src/services/org-models.ts";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("computeCostUsd", () => {
  it("returns 0 when the model has no cost table", () => {
    const usage: UpstreamUsage = { inputTokens: 1000, outputTokens: 1000 };
    expect(computeCostUsd(usage, null)).toBe(0);
  });

  it("sums input + output + cacheRead + cacheWrite per-million", () => {
    const usage: UpstreamUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    // 1M of each → exactly the per-million rate of each bucket.
    expect(computeCostUsd(usage, cost)).toBeCloseTo(3 + 15 + 0.3 + 3.75, 10);
  });

  it("prorates a fractional token count", () => {
    const usage: UpstreamUsage = { inputTokens: 500_000, outputTokens: 250_000 };
    const cost = { input: 2, output: 8 };
    // 0.5M*2 + 0.25M*8 = 1 + 2 = 3
    expect(computeCostUsd(usage, cost)).toBeCloseTo(3, 10);
  });

  it("treats absent cache token counts / cache rates as zero", () => {
    const usage: UpstreamUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const cost = { input: 5, output: 10 }; // no cacheRead / cacheWrite
    expect(computeCostUsd(usage, cost)).toBeCloseTo(5, 10);
  });
});

describe("tapSseUsage (anthropic-messages)", () => {
  it("reassembles a usage frame split across two chunks and merges start+delta", async () => {
    // The message_start frame straddles the chunk boundary; the second chunk
    // completes it and carries the terminal message_delta.
    const chunk1 = `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":150,"cache_read_input_tokens":120,"cache_creation_input_tokens":30,"output_tokens":1}}}\n\nevent: mess`;
    const chunk2 = `age_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n`;

    const usage = await tapSseUsage(streamFrom([chunk1, chunk2]), anthropicMessagesAdapter);
    expect(usage).toEqual({
      inputTokens: 150,
      outputTokens: 42,
      cacheReadTokens: 120,
      cacheWriteTokens: 30,
    });
  });

  it("flushes a final usage frame with no trailing blank-line delimiter", async () => {
    const tail = `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":10,"output_tokens":2}}}`;
    const usage = await tapSseUsage(streamFrom([tail]), anthropicMessagesAdapter);
    expect(usage?.inputTokens).toBe(10);
  });

  it("retains the message_start seed + terminal frame across many no-usage frames", async () => {
    const start = `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":200,"cache_read_input_tokens":50,"output_tokens":1}}}\n\n`;
    // A long run of usage-less delta frames between the seed and the terminal
    // frame must not evict the seed (input/cache tokens) from retention.
    const deltas = Array.from(
      { length: 100 },
      () =>
        `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n`,
    ).join("");
    const end = `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":99}}\n\n`;

    const usage = await tapSseUsage(streamFrom([start, deltas, end]), anthropicMessagesAdapter);
    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 99,
      cacheReadTokens: 50,
    });
  });

  it("returns null when the stream carries no usage-bearing frame", async () => {
    const frames = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    expect(await tapSseUsage(streamFrom([frames]), anthropicMessagesAdapter)).toBeNull();
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

describe("guardSseTeardown", () => {
  it("passes frames through unchanged when the source closes normally", async () => {
    const seen: unknown[] = [];
    const guarded = guardSseTeardown(streamFrom(["a", "bc", "d"]), (e) => seen.push(e));
    expect(await readAll(guarded)).toBe("abcd");
    expect(seen).toEqual([]);
  });

  it("catches a mid-stream source error: yields what arrived, closes, reports once", async () => {
    // The defining case: an upstream teardown that rejects AFTER bytes are on
    // the wire must NOT escape as an unhandled rejection — it closes the client
    // stream cleanly and surfaces via the callback.
    const enc = new TextEncoder();
    let sent = false;
    const boom = new Error("upstream gateway broke mid-flux");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          controller.enqueue(enc.encode("partial"));
          sent = true;
          return;
        }
        controller.error(boom);
      },
    });

    const seen: unknown[] = [];
    const guarded = guardSseTeardown(source, (e) => seen.push(e));

    // readAll must resolve (not reject) — the error was swallowed at the seam.
    expect(await readAll(guarded)).toBe("partial");
    expect(seen).toEqual([boom]);
  });

  it("full forward path: upstream errors mid-flux under alias-swap → body completes, no escape", async () => {
    // End-to-end through `forwardMeteredResponse` (tee + tap + pipeThrough swap
    // + guard). The upstream emits one frame then errors. With the guard wired
    // BEFORE the swap pipe, the returned body must read to completion (no
    // rejection escaping the `pipeThrough` internal pipe) and the one frame
    // that arrived must be alias-swapped.
    const enc = new TextEncoder();
    let sent = 0;
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) {
          controller.enqueue(enc.encode('data: {"type":"x","model":"real-model"}\n\n'));
          sent++;
          return;
        }
        controller.error(new Error("upstream gateway broke mid-flux"));
      },
    });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const ctx: MeteredForwardContext = {
      principal: { kind: "jwt_user", userId: "u", orgId: "o" },
      runId: null,
      presetId: "preset",
      // Only read by the metering path, which no-ops on the null usage an
      // errored stream yields — a minimal stand-in is sufficient here.
      resolved: {
        modelId: "real-model",
        apiShape: "anthropic-messages",
      } as unknown as ResolvedModel,
      started: 0,
    };

    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, ctx, {
      swap: { alias: "alias-model", real: "real-model" },
      logLabel: "test",
    });
    const out = await readAll(res.body!);
    expect(out).toContain("alias-model");
    expect(out).not.toContain("real-model");
  });

  it("propagates client cancel to the source without a spurious teardown error", async () => {
    let cancelledWith: unknown = undefined;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const seen: unknown[] = [];
    const guarded = guardSseTeardown(source, (e) => seen.push(e));
    const reader = guarded.getReader();
    await reader.read();
    await reader.cancel("client gone");
    expect(cancelledWith).toBe("client gone");
    // A normal disconnect must NOT be reported as an upstream teardown.
    expect(seen).toEqual([]);
  });
});
