// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Tests for the stdout-JSONL → EventSink bridge.
 *
 * Covers three classes of behaviour:
 *   - `isStdoutEventLine`: strict canonical-event matcher (rejects
 *     foreign JSON from subprocesses + malformed canonical payloads).
 *   - `mergeTerminalResult`: precedence rules for aggregate vs runner
 *     fields on finalize.
 *   - `attachStdoutBridge`: stdout interception, run-id stamping,
 *     `writeRaw` escape hatch for downstream sinks that re-emit on
 *     stdout, idempotent finalize, partial-line buffering, and
 *     aggregation across session + stdout streams.
 */

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@afps-spec/types";
import type { EventSink } from "../../src/interfaces/event-sink.ts";
import type { RunResult } from "../../src/types/run-result.ts";
import { emptyRunResult } from "../../src/runner/reducer.ts";
import {
  attachStdoutBridge,
  isStdoutEventLine,
  mergeTerminalResult,
} from "../../src/sinks/stdout-bridge.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordingSink(): EventSink & {
  handled: RunEvent[];
  finalized: RunResult | null;
} {
  const handled: RunEvent[] = [];
  let finalized: RunResult | null = null;
  return {
    handled,
    get finalized() {
      return finalized;
    },
    async handle(event) {
      handled.push(event as RunEvent);
    },
    async finalize(result) {
      finalized = result;
    },
  } as EventSink & { handled: RunEvent[]; finalized: RunResult | null };
}

/**
 * Minimal stdout-shaped fake that accepts the same `string | Uint8Array`
 * union the bridge expects. Cast to `NodeJS.WritableStream["write"]`
 * because the bridge's option type is structurally compatible with that
 * shape but the runtime never calls anything beyond `.write`.
 */
function makeFakeStdout(): {
  write: NodeJS.WritableStream["write"];
  writes: string[];
} {
  const writes: string[] = [];
  const decoder = new TextDecoder();
  const write = (chunk: string | Uint8Array, ..._rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
    writes.push(text);
    return true;
  };
  return { write: write as unknown as NodeJS.WritableStream["write"], writes };
}

/** Yield enough microtasks for fire-and-forget dispatches to settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// isStdoutEventLine
// ---------------------------------------------------------------------------

describe("isStdoutEventLine", () => {
  it("accepts a structurally valid canonical event", () => {
    expect(isStdoutEventLine({ type: "output.emitted", data: { ok: true } })).toBe(true);
    expect(isStdoutEventLine({ type: "report.appended", content: "hello" })).toBe(true);
    expect(isStdoutEventLine({ type: "memory.added", content: "m" })).toBe(true);
    expect(isStdoutEventLine({ type: "log.written", level: "info", message: "x" })).toBe(true);
  });

  it("rejects primitives, arrays, null, and untyped objects", () => {
    expect(isStdoutEventLine(null)).toBe(false);
    expect(isStdoutEventLine("hi")).toBe(false);
    expect(isStdoutEventLine(42)).toBe(false);
    expect(isStdoutEventLine([])).toBe(false);
    expect(isStdoutEventLine({})).toBe(false);
    expect(isStdoutEventLine({ type: 42 })).toBe(false);
  });

  it("rejects unknown event types — guards against subprocess JSON output", () => {
    // npm --json, jq, builders, … may print JSON with a `type` field.
    // Strict canonical-vocabulary check keeps them out of the bridge.
    expect(isStdoutEventLine({ type: "build.done", success: true })).toBe(false);
    expect(isStdoutEventLine({ type: "npm.audit", vulnerabilities: 0 })).toBe(false);
    expect(isStdoutEventLine({ type: "" })).toBe(false);
  });

  it("rejects canonical types with malformed payloads", () => {
    // `output.emitted` requires `data` to be present.
    expect(isStdoutEventLine({ type: "output.emitted" })).toBe(false);
    // `memory.added` requires string `content`.
    expect(isStdoutEventLine({ type: "memory.added", content: 42 })).toBe(false);
    // `log.written` requires a valid level and string message.
    expect(isStdoutEventLine({ type: "log.written", level: "bogus", message: "x" })).toBe(false);
    expect(isStdoutEventLine({ type: "log.written", level: "info" })).toBe(false);
    // `pinned.set` requires non-empty string key + content presence.
    expect(isStdoutEventLine({ type: "pinned.set", key: "", content: "x" })).toBe(false);
    expect(isStdoutEventLine({ type: "pinned.set", key: "k" })).toBe(false);
    // `report.appended` requires string content.
    expect(isStdoutEventLine({ type: "report.appended", content: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeTerminalResult
// ---------------------------------------------------------------------------

describe("mergeTerminalResult", () => {
  it("prefers aggregate values when present, falls back to runner values", () => {
    const aggregate: RunResult = {
      memories: [{ content: "hello" }],
      pinned: { checkpoint: { content: { step: 2 } } },
      output: { foo: "bar" },
      logs: [{ level: "info", message: "x", timestamp: 100 }],
    };
    const runner: RunResult = {
      memories: [{ content: "old" }],
      pinned: { checkpoint: { content: { step: 1 } } },
      output: { foo: "baz" },
      logs: [{ level: "info", message: "y", timestamp: 50 }],
      status: "success",
      durationMs: 123,
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.memories).toEqual([{ content: "hello" }]);
    expect(merged.pinned!.checkpoint).toEqual({ content: { step: 2 } });
    expect(merged.output).toEqual({ foo: "bar" });
    expect(merged.logs).toEqual([{ level: "info", message: "x", timestamp: 100 }]);
    // Terminal metadata always comes from the runner.
    expect(merged.status).toBe("success");
    expect(merged.durationMs).toBe(123);
  });

  it("falls back to runner values for every field the aggregate left empty", () => {
    const aggregate = emptyRunResult();
    const runner: RunResult = {
      memories: [{ content: "r" }],
      pinned: { checkpoint: { content: { ok: true } } },
      output: { answer: 42 },
      logs: [{ level: "warn", message: "w", timestamp: 1 }],
      status: "failed",
      error: { message: "boom" },
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.memories).toEqual([{ content: "r" }]);
    expect(merged.pinned!.checkpoint).toEqual({ content: { ok: true } });
    expect(merged.output).toEqual({ answer: 42 });
    expect(merged.logs).toHaveLength(1);
    expect(merged.status).toBe("failed");
    expect(merged.error).toEqual({ message: "boom" });
  });

  it("omits status / error / durationMs when runner did not provide them", () => {
    const merged = mergeTerminalResult(emptyRunResult(), emptyRunResult());
    expect("status" in merged).toBe(false);
    expect("error" in merged).toBe(false);
    expect("durationMs" in merged).toBe(false);
  });

  it("forwards runner.usage onto the merged result", () => {
    // The bridge aggregator only sees AFPS canonical events, never
    // `appstrate.metric` — usage MUST come from the runner side so the
    // platform's finalize endpoint can read authoritative token counts
    // without waiting on the side-channel metric event.
    const aggregate = emptyRunResult();
    const runner: RunResult = {
      ...emptyRunResult(),
      status: "success",
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_creation_input_tokens: 6,
        cache_read_input_tokens: 7,
      },
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.usage).toEqual({
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 6,
      cache_read_input_tokens: 7,
    });
  });

  it("omits usage when runner did not provide it", () => {
    const merged = mergeTerminalResult(emptyRunResult(), emptyRunResult());
    expect("usage" in merged).toBe(false);
  });

  it("forwards runner.cost onto the merged result", () => {
    const aggregate = emptyRunResult();
    const runner: RunResult = {
      ...emptyRunResult(),
      status: "success",
      cost: 0.0123,
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.cost).toBeCloseTo(0.0123, 5);
  });

  it("omits cost when runner did not provide it", () => {
    const merged = mergeTerminalResult(emptyRunResult(), emptyRunResult());
    expect("cost" in merged).toBe(false);
  });

  it("prefers aggregate.report over runner.report", () => {
    const merged = mergeTerminalResult(
      { ...emptyRunResult(), report: "from bridge" },
      { ...emptyRunResult(), report: "from runner" },
    );
    expect(merged.report).toBe("from bridge");
  });

  it("falls back to runner.report when bridge aggregated none", () => {
    const merged = mergeTerminalResult(emptyRunResult(), {
      ...emptyRunResult(),
      report: "from runner",
    });
    expect(merged.report).toBe("from runner");
  });

  it("omits report when neither side provided one", () => {
    const merged = mergeTerminalResult(emptyRunResult(), emptyRunResult());
    expect("report" in merged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// attachStdoutBridge — stdout interception
// ---------------------------------------------------------------------------

describe("attachStdoutBridge — stdout interception", () => {
  it("parses JSON-line events, stamps runId, and forwards to the sink", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "run_abc", stdout });

    stdout.write.call(null as never, '{"type":"output.emitted","data":{"hello":true}}\n');

    await flushMicrotasks();

    expect(underlying.handled).toHaveLength(1);
    const event = underlying.handled[0]!;
    expect(event.type).toBe("output.emitted");
    expect((event as { runId: string }).runId).toBe("run_abc");
    // The bridge consumed the line — it didn't reach the original stream.
    expect(stdout.writes).toHaveLength(0);
    bridge.restore();
  });

  it("overrides a stale runId in the JSON payload with the bridge's runId", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "run_canonical", stdout });

    stdout.write.call(
      null as never,
      '{"type":"output.emitted","data":{"x":1},"runId":"unknown"}\n',
    );

    await flushMicrotasks();

    expect((underlying.handled[0] as { runId: string }).runId).toBe("run_canonical");
    bridge.restore();
  });

  it("passes non-JSON writes through to the original stdout", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, "plain text line\n");
    stdout.write.call(null as never, "another\n");

    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(["plain text line\n", "another\n"]);
    bridge.restore();
  });

  it("handles chunked writes — events split across multiple writes are still parsed", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, '{"type":"output.emi');
    stdout.write.call(null as never, 'tted","data":{"chunk":true}}\n');

    await flushMicrotasks();

    expect(underlying.handled).toHaveLength(1);
    expect(underlying.handled[0]!.type).toBe("output.emitted");
    bridge.restore();
  });

  it("decodes multi-byte UTF-8 split across chunks (streaming decoder)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    // `é` = UTF-8 [0xC3, 0xA9]. Split the byte sequence so the decoder
    // sees an incomplete multi-byte char on the first call. Without
    // `{ stream: true }` the bridge would emit U+FFFD and corrupt the
    // event payload.
    const fullJson = '{"type":"output.emitted","data":{"name":"café"}}\n';
    const fullBytes = new TextEncoder().encode(fullJson);
    // Locate the `é` (0xC3 0xA9) and split between its two bytes.
    const eIndex = fullBytes.indexOf(0xc3);
    expect(eIndex).toBeGreaterThan(0);
    const writeChunk = stdout.write as unknown as (chunk: string | Uint8Array) => boolean;
    writeChunk(fullBytes.slice(0, eIndex + 1)); // …0xC3
    writeChunk(fullBytes.slice(eIndex + 1)); //   0xA9…\n
    await flushMicrotasks();

    expect(underlying.handled).toHaveLength(1);
    const ev = underlying.handled[0]! as unknown as { data: { name: string } };
    expect(ev.data.name).toBe("café");
    bridge.restore();
  });

  it("handles Uint8Array (and Buffer, by inheritance) chunks", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    // `NodeJS.WritableStream["write"]` overloads narrow the first arg to
    // `string`; cast through `unknown` to also exercise the `Uint8Array`
    // branch at runtime.
    (stdout.write as unknown as (chunk: string | Uint8Array) => boolean)(
      new TextEncoder().encode('{"type":"output.emitted","data":{"buf":true}}\n'),
    );

    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(1);
    expect(underlying.handled[0]!.type).toBe("output.emitted");
    bridge.restore();
  });

  it("ignores malformed JSON lines (falls through to passthrough)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, "{not valid json\n");

    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(["{not valid json\n"]);
    bridge.restore();
  });

  it("ignores foreign JSON (subprocess output) — strict canonical match", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    // A subprocess like `npm --json` could legitimately print this.
    stdout.write.call(null as never, '{"type":"npm.audit","vulnerabilities":0}\n');
    // An object with no `type` at all.
    stdout.write.call(null as never, '{"foo":"bar"}\n');
    // A canonical-typed line with malformed payload — still rejected.
    stdout.write.call(null as never, '{"type":"output.emitted"}\n');

    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual([
      '{"type":"npm.audit","vulnerabilities":0}\n',
      '{"foo":"bar"}\n',
      '{"type":"output.emitted"}\n',
    ]);
    bridge.restore();
  });
});

// ---------------------------------------------------------------------------
// attachStdoutBridge — writeRaw escape hatch
// ---------------------------------------------------------------------------

describe("attachStdoutBridge — writeRaw", () => {
  it("writes through the original stdout without re-parsing — anti-recursion guard", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    // Simulates a downstream sink (e.g. CLI `--json` console sink) that
    // re-emits a canonical event on stdout after receiving it. Without
    // writeRaw, the bridge would re-aspirate and dispatch a second time
    // — infinite loop. With writeRaw, the chunk reaches the original
    // stream untouched.
    bridge.writeRaw('{"type":"output.emitted","data":{"echo":true}}\n');

    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(['{"type":"output.emitted","data":{"echo":true}}\n']);
    bridge.restore();
  });

  it("accepts Uint8Array chunks", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    bridge.writeRaw(new TextEncoder().encode("raw bytes\n"));

    await flushMicrotasks();
    expect(stdout.writes).toEqual(["raw bytes\n"]);
    bridge.restore();
  });
});

// ---------------------------------------------------------------------------
// attachStdoutBridge — aggregation + finalize merge
// ---------------------------------------------------------------------------

describe("attachStdoutBridge — aggregation via finalize", () => {
  it("aggregates output.emitted + pinned.set across session + stdout", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    // Session-style: emit via the bridge sink directly (what a runner does).
    await bridge.sink.handle({
      type: "pinned.set",
      timestamp: 1,
      runId: "r",
      key: "checkpoint",
      content: { step: 1 },
    });

    // Stdout-style: a tool writes a JSON line.
    stdout.write.call(
      null as never,
      '{"type":"output.emitted","data":{"answer":42},"timestamp":3}\n',
    );

    await flushMicrotasks();

    // Runner finalises with its OWN (incomplete) result — the bridge
    // must merge its aggregate into the finalize payload.
    await bridge.sink.finalize({
      ...emptyRunResult(),
      status: "success",
      durationMs: 500,
    });

    expect(underlying.finalized).not.toBeNull();
    const final = underlying.finalized!;
    expect(final.output).toEqual({ answer: 42 });
    expect(final.pinned!.checkpoint).toEqual({ content: { step: 1 } });
    expect(final.status).toBe("success");
    expect(final.durationMs).toBe(500);
    bridge.restore();
  });

  it("is idempotent — a second finalize is a no-op (runner + safety-net race)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    await bridge.sink.finalize({ ...emptyRunResult(), status: "success" });
    const firstFinalized = underlying.finalized;
    await bridge.sink.finalize({ ...emptyRunResult(), status: "failed" });

    expect(underlying.finalized).toBe(firstFinalized);
    expect(underlying.finalized!.status).toBe("success");
    bridge.restore();
  });

  it("forwards every handled event to the underlying sink (tee semantics)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    await bridge.sink.handle({
      type: "memory.added",
      timestamp: 1,
      runId: "r",
      content: "m1",
    });
    await bridge.sink.handle({
      type: "memory.added",
      timestamp: 2,
      runId: "r",
      content: "m2",
    });

    expect(underlying.handled).toHaveLength(2);
    bridge.restore();
  });

  it("aggregates pinned.set with key='checkpoint' into result.pinned with scope captured", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(
      null as never,
      '{"type":"pinned.set","key":"checkpoint","content":{"cursor":"abc"},"scope":"shared","timestamp":1}\n',
    );
    await flushMicrotasks();

    await bridge.sink.finalize({ ...emptyRunResult(), status: "success" });

    const final = underlying.finalized!;
    expect(final.pinned!.checkpoint).toEqual({ content: { cursor: "abc" }, scope: "shared" });
    bridge.restore();
  });

  it("aggregates pinned.set with arbitrary key into result.pinned", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(
      null as never,
      '{"type":"pinned.set","key":"persona","content":"agent persona","timestamp":1}\n',
    );
    await flushMicrotasks();

    await bridge.sink.finalize({ ...emptyRunResult(), status: "success" });

    const final = underlying.finalized!;
    expect(final.pinned).toEqual({ persona: { content: "agent persona" } });
    expect(final.pinned!.checkpoint).toBeUndefined();
    bridge.restore();
  });

  it("aggregates report.appended into result.report (joined with newlines)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });

    stdout.write.call(
      null as never,
      '{"type":"report.appended","content":"chunk 1","timestamp":1}\n',
    );
    stdout.write.call(
      null as never,
      '{"type":"report.appended","content":"chunk 2","timestamp":2}\n',
    );
    await flushMicrotasks();

    await bridge.sink.finalize({ ...emptyRunResult(), status: "success" });

    const final = underlying.finalized!;
    expect(final.report).toBe("chunk 1\nchunk 2");
    bridge.restore();
  });
});

// ---------------------------------------------------------------------------
// attachStdoutBridge — restore
// ---------------------------------------------------------------------------

describe("attachStdoutBridge — restore", () => {
  it("restores stdout passthrough and clears the partial buffer", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const interceptedWrite = stdout.write;

    const bridge = attachStdoutBridge({ sink: underlying, runId: "r", stdout });
    // Bridge swapped the write fn for its interceptor.
    expect(stdout.write).not.toBe(interceptedWrite);

    // Leave a half-written event in the buffer to exercise the clear.
    stdout.write.call(null as never, '{"type":"output.emitted","data":{"x":');

    bridge.restore();
    // Restore swapped it back. Identity check would compare against the
    // bridge's bound copy, not the test's reference, so we instead
    // verify behaviour: the interceptor is gone — JSON lines no longer
    // reach the sink, and the partial buffer was cleared so the
    // half-written event leaks no trailing dispatch on the next chunk.
    stdout.write.call(null as never, '1}}\n{"type":"output.emitted","data":{"y":2}}\n');
    await flushMicrotasks();
    expect(underlying.handled).toHaveLength(0);
    // Both fragments reached the original stream untouched (no parsing,
    // no concatenation with the cleared buffer).
    expect(stdout.writes).toEqual(['1}}\n{"type":"output.emitted","data":{"y":2}}\n']);
  });
});
