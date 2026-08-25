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
  recordProxyUsage,
  UNPARSED_USAGE_REQUEST_ID_PREFIX,
  type MeteredForwardContext,
  type RecordUsageInputs,
} from "../../src/services/llm-proxy/metering.ts";
import type { LlmUsageEntry } from "../../src/services/llm-usage-ledger.ts";
import { anthropicMessagesAdapter } from "../../src/services/llm-proxy/anthropic.ts";
import { openaiCompletionsAdapter } from "../../src/services/llm-proxy/openai.ts";
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

  it("bills DeepSeek cache hits at the cache-read rate, not double-counted as input", () => {
    // End-to-end: parse a DeepSeek-shape usage payload, then price it with the
    // real DeepSeek V4 Flash rates ($0.14/M input, $0.0028/M cache hit,
    // $0.28/M output). prompt_tokens = hit + miss = 800k + 200k.
    const usage = openaiCompletionsAdapter.parseJsonUsage({
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        prompt_cache_hit_tokens: 800_000,
        prompt_cache_miss_tokens: 200_000,
      },
    });
    expect(usage).toEqual({
      inputTokens: 200_000, // cache-MISS remainder only
      outputTokens: 1_000_000,
      cacheReadTokens: 800_000,
    });

    const cost = { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 };
    // Correct: 0.2M×0.14 + 1M×0.28 + 0.8M×0.0028 = 0.028 + 0.28 + 0.00224.
    const expected = 0.028 + 0.28 + 0.00224;
    expect(computeCostUsd(usage!, cost)).toBeCloseTo(expected, 10);

    // Guard against the double-count regression: had inputTokens still included
    // the 800k cache hits, input cost would be 1M×0.14 = 0.14 instead of 0.028
    // — the whole bill would jump by 0.112. Prove we're NOT there.
    const doubleCounted = 1_000_000 * 0.14e-6 + 1_000_000 * 0.28e-6 + 800_000 * 0.0028e-6;
    expect(computeCostUsd(usage!, cost)).toBeLessThan(doubleCounted);
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

  it("an idle upstream ends the tap with what it parsed, instead of hanging", async () => {
    // Without a bound here the tap kept a pending `read()` forever: the ledger
    // row for a paid 2xx was never written (the module's accounting invariant),
    // and the tee branch it holds kept the upstream socket pinned.
    const enc = new TextEncoder();
    const seed = `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":1}}}\n\n`;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(seed));
        // Never closes, never speaks again.
      },
    });
    const usage = await tapSseUsage(source, anthropicMessagesAdapter, 25);
    expect(usage?.inputTokens).toBe(11);
  });

  it("idle stall releases BOTH tee branches, so the upstream source is cancelled", async () => {
    // `tee()` cancels its source only once BOTH branches are cancelled. The
    // client branch alone was not enough: the metering tap held the other one,
    // and `guardedFetch` has already detached its timer at the headers — so a
    // stream that died after its headers landed stayed pinned with no deadline
    // behind it at all.
    const enc = new TextEncoder();
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"type":"x"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const [clientBranch, tapBranch] = source.tee();
    const seen: unknown[] = [];
    const guarded = guardSseTeardown(clientBranch, (e) => seen.push(e), 25);
    await Promise.all([tapSseUsage(tapBranch, anthropicMessagesAdapter, 25), readAll(guarded)]);
    // Both cancels are fired as detached promises; let them settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
    expect(seen).toHaveLength(1);
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

/**
 * Minimal forwarding context. `resolved` is only read by the metering path,
 * which no-ops when a branch never parses usage (error bodies, non-JSON) — a
 * stand-in is sufficient for these pure forwarding tests.
 */
/**
 * Ledger-writer seam for the forwarding tests: collects what WOULD be recorded
 * so the branches can be exercised without a database (the DI point
 * `MeteredForwardOptions.recordUsage` exists for exactly this).
 */
function collectUsage(): { calls: RecordUsageInputs[]; recordUsage: MeterSeam } {
  const calls: RecordUsageInputs[] = [];
  return {
    calls,
    recordUsage: async (inputs) => {
      calls.push(inputs);
    },
  };
}
type MeterSeam = (inputs: RecordUsageInputs) => Promise<void>;

function makeCtx(overrides: Partial<MeteredForwardContext> = {}): MeteredForwardContext {
  return {
    principal: { kind: "jwt_user", userId: "u", orgId: "o" },
    runId: null,
    chatSessionId: null,
    presetId: "preset",
    resolved: {
      modelId: "real-model",
      apiShape: "anthropic-messages",
    } as unknown as ResolvedModel,
    started: 0,
    ...overrides,
  };
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

  // --- inter-chunk idle bound ---
  //
  // `guardSseTeardown` also bounds how long the UPSTREAM may stay silent
  // between two chunks (`LLM_STREAM_IDLE_TIMEOUT_MS`, 120 s in production;
  // passed as a few ms here). Four of the ten api shapes this platform maps
  // ignore pi-ai's own `timeoutMs`, so before this bound a stalled
  // Gemini/Vertex/Bedrock stream on the chat path had no deadline at all.
  //
  // Two invariants are pinned below: expiry follows the module's
  // never-error contract (report via `onTeardownError`, close cleanly), and a
  // SLOW CONSUMER on a healthy upstream is not a timeout.

  it("idle upstream: reports via onTeardownError and closes cleanly (never errors the stream)", async () => {
    const enc = new TextEncoder();
    // One frame, then permanent silence — the consumer keeps pulling, so the
    // read stays pending and only the idle bound can end it.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("partial"));
      },
    });

    const seen: unknown[] = [];
    const guarded = guardSseTeardown(source, (e) => seen.push(e), 25);

    // Resolves, does NOT reject: erroring here would re-open the
    // unhandled-rejection leak this module exists to close (the guard is
    // wrapped BEFORE the alias-swap `pipeThrough`).
    expect(await readAll(guarded)).toBe("partial");
    expect(seen).toHaveLength(1);
    // The message is a SERVER-SIDE signal only (`onTeardownError` is a logger
    // call at the real call site, and the client stream closes cleanly), so
    // this pins that the stall is reported and named — not that the wording
    // reaches the caller. See the branch in `metering.ts` for what the caller
    // actually classifies on.
    expect((seen[0] as Error).message).toMatch(/timed out/i);
  });

  it("does NOT trip on a slow consumer reading a healthy upstream", async () => {
    // REGRESSION CONTROL. `pull` is demand-driven: an idle timer that keeps
    // running between pulls (or one hung off a "time since last chunk"
    // counter) would kill a merely slow consumer on a perfectly healthy
    // upstream. The upstream below answers every pull instantly; the consumer
    // waits far longer than the idle bound between reads.
    const enc = new TextEncoder();
    const payloads = ["a", "b", "c", "d"];
    let next = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= payloads.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(payloads[next]!));
        next += 1;
      },
    });

    const idleTimeoutMs = 15;
    const seen: unknown[] = [];
    const guarded = guardSseTeardown(source, (e) => seen.push(e), idleTimeoutMs);

    const consumerGapMs = idleTimeoutMs * 5;
    const reader = guarded.getReader();
    const dec = new TextDecoder();
    let out = "";
    const gaps: number[] = [];
    for (;;) {
      const before = Date.now();
      await new Promise((r) => setTimeout(r, consumerGapMs));
      const { done, value } = await reader.read();
      gaps.push(Date.now() - before);
      if (done) break;
      out += dec.decode(value, { stream: true });
    }

    expect(out).toBe(payloads.join(""));
    expect(seen).toEqual([]);
    // Proof the control tests the right thing: every consumer gap really did
    // exceed the idle bound, so any implementation timing the wrong interval
    // would have reported a teardown above.
    expect(Math.min(...gaps)).toBeGreaterThan(idleTimeoutMs);
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
    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
      swap: {
        alias: "alias-model",
        real: "real-model",
        clientApiShape: "anthropic-messages" as const,
        backingApiShape: "anthropic-messages" as const,
      },
      recordUsage: collectUsage().recordUsage,
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

// Alias error synthesis + response-header allowlist (issue #727). For an
// aliased model an upstream error body is never forwarded — it is REPLACED by
// the neutral synthetic envelope — and response headers are reduced to the
// shared allowlist, so neither prose nor headers can fingerprint the backing.
// The no-swap path stays byte-for-byte permissive (subscription gateways).
describe("forwardMeteredResponse — aliased error synthesis and header allowlist", () => {
  const swap = {
    alias: "appstrate-medium",
    real: "deepseek-SECRET",
    // The gateway PROXIES: its caller already speaks the backing's protocol,
    // so both fields carry the same shape (unlike the sidecar on an aliased
    // agent run, whose client speaks `pi-messages`).
    clientApiShape: "anthropic-messages" as const,
    backingApiShape: "anthropic-messages" as const,
  };

  it("forwards a GENERIC upstream status verbatim on an aliased model", async () => {
    // The control that keeps the projection from becoming a blanket 502: a
    // status every vendor answers alike carries no fingerprint, and collapsing
    // it would lose the one classification signal the scrubbed body left.
    for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]) {
      const upstream = new Response(JSON.stringify({ error: { message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
      const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
        swap,
      });
      expect(res.status).toBe(status);
    }
  });

  it("replaces an aliased upstream error body with the synthetic envelope and strips fingerprinting headers", async () => {
    const upstream = new Response(
      JSON.stringify({
        error: { message: "The model `deepseek-SECRET` is overloaded, try api.deepseek.com" },
      }),
      {
        status: 529,
        headers: {
          "content-type": "application/json",
          server: "cloudflare",
          "cf-ray": "8f2a-CDG",
          "anthropic-organization-id": "org_123",
          "openai-organization": "org-abc",
          "retry-after": "7",
          "x-request-id": "req_1",
        },
      },
    );

    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
      swap,
    });

    // The body is the neutral envelope — nothing of the upstream prose (nor
    // the real id) survives. The STATUS is projected before it is disclosed:
    // 529 is Anthropic's own overload code, so forwarding it would name the
    // backing the body was scrubbed to hide. It collapses to 502, which is
    // still retryable, so the retry/backoff contract is unchanged.
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).toContain("appstrate-medium");
    expect(text).toContain("Upstream model error");
    expect(text).not.toContain("deepseek-SECRET");
    expect(text).not.toContain("overloaded");

    // Fingerprinting headers are dropped; allowlisted operational ones flow.
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("cf-ray")).toBeNull();
    expect(res.headers.get("anthropic-organization-id")).toBeNull();
    expect(res.headers.get("openai-organization")).toBeNull();
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("x-request-id")).toBe("req_1");
  });

  it("forwards a no-swap upstream error verbatim with permissive headers", async () => {
    const body = JSON.stringify({ error: { message: "rate limited" } });
    const upstream = new Response(body, {
      status: 529,
      headers: { "content-type": "application/json", server: "cloudflare" },
    });

    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {});

    expect(res.status).toBe(529);
    // Permissive path intact: the fingerprinting header passes through.
    expect(res.headers.get("server")).toBe("cloudflare");
    expect(await res.text()).toBe(body);
  });

  it("synthesizes a 502 envelope for a non-JSON 2xx under a swap", async () => {
    // An unparsable 2xx body can't have its echoed real id rewritten, so the
    // alias contract can't be upheld — the gateway degrades it to a 502.
    const upstream = new Response("<html>served by deepseek-SECRET</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const meter = collectUsage();
    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
      swap,
      recordUsage: meter.recordUsage,
    });

    // The call was accepted (and paid for) upstream — it is metered even though
    // the caller receives a 502.
    expect(meter.calls).toHaveLength(1);
    expect(meter.calls[0]!.usage).toBeNull();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).toContain("appstrate-medium");
    expect(text).toContain("Upstream model error");
    expect(text).not.toContain("deepseek-SECRET");
    expect(text).not.toContain("<html>");
  });

  it("keeps a no-swap non-JSON 2xx verbatim", async () => {
    const upstream = new Response("plain text ok", {
      status: 200,
      headers: { "content-type": "text/plain", server: "cloudflare" },
    });

    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
      recordUsage: collectUsage().recordUsage,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("server")).toBe("cloudflare");
    expect(await res.text()).toBe("plain text ok");
  });
});

/**
 * A 2xx reply the platform could not price is still a call the provider was paid
 * for. It must reach the ledger as an ACCOUNTABLE zero row (explicitly marked),
 * never as silence — otherwise it exists neither in `runs.cost` nor for billing,
 * and nothing even counts how often it happens.
 */
describe("forwardMeteredResponse — a paid 2xx never escapes the ledger", () => {
  it("meters an SSE stream that carried no usage frame", async () => {
    const body = streamFrom([
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ]);
    const upstream = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const meter = collectUsage();
    const res = await forwardMeteredResponse(upstream, anthropicMessagesAdapter, makeCtx(), {
      recordUsage: meter.recordUsage,
    });
    // The tap runs out-of-band of the client stream: drain the body first.
    await readAll(res.body!);
    // One tick for the detached tap → meter chain to settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(meter.calls).toHaveLength(1);
    expect(meter.calls[0]!.usage).toBeNull();
  });

  it("meters a JSON 2xx whose body carries no usage object", async () => {
    const upstream = new Response(JSON.stringify({ id: "cmpl_1", choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const meter = collectUsage();
    await forwardMeteredResponse(upstream, openaiCompletionsAdapter, makeCtx(), {
      recordUsage: meter.recordUsage,
    });

    expect(meter.calls).toHaveLength(1);
    expect(meter.calls[0]!.usage).toBeNull();
  });

  it("never meters an upstream ERROR — no tokens were produced", async () => {
    const upstream = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });

    const meter = collectUsage();
    await forwardMeteredResponse(upstream, openaiCompletionsAdapter, makeCtx(), {
      recordUsage: meter.recordUsage,
    });

    expect(meter.calls).toEqual([]);
  });

  it("builds a zero-token entry with a marked request_id for an unparseable usage", async () => {
    // `recordProxyUsage` with the ledger writer injected: the row it hands to
    // the single writer is what an operator can later find and count.
    const written: LlmUsageEntry[] = [];
    await recordProxyUsage(
      {
        principal: { kind: "jwt_user", userId: "u1", orgId: "org1" },
        runId: "run_1",
        chatSessionId: null,
        presetId: "preset-1",
        resolved: {
          modelId: "gpt-4o",
          apiShape: "openai-completions",
          isSystemModel: true,
          cost: { input: 3, output: 15 },
        } as unknown as ResolvedModel,
        usage: null,
        durationMs: 120,
      },
      async (entry) => {
        written.push(entry);
      },
    );

    expect(written).toHaveLength(1);
    const entry = written[0]!;
    expect(entry.source).toBe("proxy");
    expect(entry.runId).toBe("run_1");
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.cacheReadTokens).toBeNull();
    expect(entry.cacheWriteTokens).toBeNull();
    expect(entry.costUsd).toBe(0);
    expect(entry.credentialSource).toBe("system");
    expect(entry.requestId?.startsWith(UNPARSED_USAGE_REQUEST_ID_PREFIX)).toBe(true);
  });
});

/**
 * Pricing provenance on the proxy row (issue #1025 §B). `cost_usd = 0` is
 * unattributable on its own; these pin which of the three verdicts each shape
 * of (rates × usage) produces, and — critically — that the PARSE gap and the
 * PRICING gap stay independent: the `usage-unparsed:` marker lives on
 * `request_id`, so `pricing_status` keeps answering only "did the platform have
 * rates for this model".
 */
describe("recordProxyUsage — pricing provenance", () => {
  async function entryFor(
    resolved: Partial<ResolvedModel>,
    usage: UpstreamUsage | null,
  ): Promise<LlmUsageEntry> {
    const written: LlmUsageEntry[] = [];
    await recordProxyUsage(
      {
        principal: { kind: "jwt_user", userId: "u1", orgId: `org_${crypto.randomUUID()}` },
        runId: null,
        chatSessionId: null,
        presetId: `preset_${crypto.randomUUID()}`,
        resolved: {
          modelId: "gpt-4o",
          apiShape: "openai-completions",
          ...resolved,
        } as ResolvedModel,
        usage,
        durationMs: 10,
      },
      async (entry) => {
        written.push(entry);
      },
    );
    return written[0]!;
  }

  it("stamps `priced` when every bucket that carried tokens had a rate", async () => {
    const entry = await entryFor(
      { cost: { input: 3, output: 15, cacheRead: 0.3 } },
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
    );
    expect(entry.pricingStatus).toBe("priced");
  });

  it("stamps `unpriced` when the model resolved no rates at all — the $0 is an absence", async () => {
    const entry = await entryFor({ cost: null }, { inputTokens: 1000, outputTokens: 1000 });
    expect(entry.pricingStatus).toBe("unpriced");
    expect(entry.costUsd).toBe(0);
  });

  it("stamps `partial` when cached tokens were reported with no cache-read rate", async () => {
    const entry = await entryFor(
      { cost: { input: 3, output: 15 } },
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
    );
    expect(entry.pricingStatus).toBe("partial");
  });

  it("keeps the parse gap and the pricing gap separable on an unparseable-usage row", async () => {
    // Same zero-token row, two different models: the marker on `request_id`
    // reports the parse failure in BOTH, while `pricing_status` reports only
    // whether rates existed. Folding one into the other would lose a signal.
    const priced = await entryFor({ cost: { input: 3, output: 15 } }, null);
    expect(priced.requestId?.startsWith(UNPARSED_USAGE_REQUEST_ID_PREFIX)).toBe(true);
    expect(priced.pricingStatus).toBe("priced");

    const unpriced = await entryFor({ cost: null }, null);
    expect(unpriced.requestId?.startsWith(UNPARSED_USAGE_REQUEST_ID_PREFIX)).toBe(true);
    expect(unpriced.pricingStatus).toBe("unpriced");
  });
});
