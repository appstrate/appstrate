// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the runtime-pi tee sink + stdout bridge.
 *
 * These cover the exact failure the transport-swap refactor introduced:
 * system tools emit canonical domain events via
 * `process.stdout.write(JSON+\n)`, and under the HttpSink protocol
 * those events were being dropped because PiRunner's internal reducer
 * only sees its own session events. The tee sink folds every event
 * (session + stdout) into a shared aggregate and merges it into the
 * terminal finalize POST so the platform sees the complete result.
 */

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { attachTeeSink, mergeTerminalResult, looksLikeRunEvent } from "../tee-sink.ts";

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

function makeFakeStdout() {
  const writes: string[] = [];
  const write = (chunk: string | Buffer | Uint8Array, ..._rest: unknown[]): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    writes.push(text);
    return true;
  };
  return { write: write as unknown as NodeJS.WritableStream["write"], writes };
}

// ---------------------------------------------------------------------------
// looksLikeRunEvent
// ---------------------------------------------------------------------------

describe("looksLikeRunEvent", () => {
  it("accepts objects with a string type", () => {
    expect(looksLikeRunEvent({ type: "report.appended" })).toBe(true);
  });
  it("rejects primitives, arrays, null, and untyped objects", () => {
    expect(looksLikeRunEvent(null)).toBe(false);
    expect(looksLikeRunEvent("hi")).toBe(false);
    expect(looksLikeRunEvent(42)).toBe(false);
    expect(looksLikeRunEvent([])).toBe(false);
    expect(looksLikeRunEvent({})).toBe(false);
    expect(looksLikeRunEvent({ type: 42 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeTerminalResult
// ---------------------------------------------------------------------------

describe("mergeTerminalResult", () => {
  it("prefers aggregate values when present, falls back to runner values", () => {
    const aggregate: RunResult = {
      memories: [{ content: "hello" }],
      checkpoint: { step: 2 },
      output: { foo: "bar" },
      report: "# Report\nline",
      logs: [{ level: "info", message: "x", timestamp: 100 }],
    };
    const runner: RunResult = {
      memories: [{ content: "old" }],
      checkpoint: { step: 1 },
      output: { foo: "baz" },
      report: "fallback",
      logs: [{ level: "info", message: "y", timestamp: 50 }],
      status: "success",
      durationMs: 123,
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.memories).toEqual([{ content: "hello" }]);
    expect(merged.checkpoint).toEqual({ step: 2 });
    expect(merged.output).toEqual({ foo: "bar" });
    expect(merged.report).toBe("# Report\nline");
    expect(merged.logs).toEqual([{ level: "info", message: "x", timestamp: 100 }]);
    // Terminal metadata always comes from the runner.
    expect(merged.status).toBe("success");
    expect(merged.durationMs).toBe(123);
  });

  it("falls back to runner values for every field the aggregate left empty", () => {
    const aggregate = emptyRunResult();
    const runner: RunResult = {
      memories: [{ content: "r" }],
      checkpoint: { ok: true },
      output: { answer: 42 },
      report: "runner-report",
      logs: [{ level: "warn", message: "w", timestamp: 1 }],
      status: "failed",
      error: { message: "boom" },
    };
    const merged = mergeTerminalResult(aggregate, runner);
    expect(merged.memories).toEqual([{ content: "r" }]);
    expect(merged.checkpoint).toEqual({ ok: true });
    expect(merged.output).toEqual({ answer: 42 });
    expect(merged.report).toBe("runner-report");
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
    // The tee aggregator only sees canonical AFPS events, never
    // `appstrate.metric` — so usage MUST come from the runner side.
    // This is the path that lets the platform's finalize endpoint read
    // an authoritative token count without waiting on the metric event.
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
    // Same rationale as `usage`: cost must come from the runner side
    // so finalize can synthesise the runner-source ledger row without
    // waiting on the metric event POST.
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
});

// ---------------------------------------------------------------------------
// attachTeeSink — stdout bridge + aggregation
// ---------------------------------------------------------------------------

describe("attachTeeSink — stdout bridge", () => {
  it("parses JSON-line events, stamps runId, and forwards to the sink", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "run_abc", stdout });

    // System-tool-style emission: JSON + newline.
    stdout.write.call(null as never, '{"type":"report.appended","content":"hello"}\n');

    // Yield a microtask so the fire-and-forget dispatch resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(underlying.handled).toHaveLength(1);
    const event = underlying.handled[0]!;
    expect(event.type).toBe("report.appended");
    expect((event as { runId: string }).runId).toBe("run_abc");
    // Non-event writes were NOT passed through — the bridge consumed the line.
    expect(stdout.writes).toHaveLength(0);
    tee.restore();
  });

  it("passes non-JSON writes through to the original stdout", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, "plain text line\n");
    stdout.write.call(null as never, "another\n");

    await Promise.resolve();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(["plain text line\n", "another\n"]);
    tee.restore();
  });

  it("handles chunked writes — events split across multiple writes are still parsed", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, '{"type":"report.appe');
    stdout.write.call(null as never, 'nded","content":"chunk"}\n');

    await Promise.resolve();
    await Promise.resolve();

    expect(underlying.handled).toHaveLength(1);
    expect(underlying.handled[0]!.type).toBe("report.appended");
    tee.restore();
  });

  it("ignores malformed JSON lines (falls through to passthrough)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, "{not valid json\n");

    await Promise.resolve();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(["{not valid json\n"]);
    tee.restore();
  });

  it("rejects JSON objects without a `type` string (not a RunEvent)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    stdout.write.call(null as never, '{"foo":"bar"}\n');

    await Promise.resolve();
    expect(underlying.handled).toHaveLength(0);
    expect(stdout.writes).toEqual(['{"foo":"bar"}\n']);
    tee.restore();
  });
});

// ---------------------------------------------------------------------------
// attachTeeSink — aggregation + finalize merge
// ---------------------------------------------------------------------------

describe("attachTeeSink — aggregation via finalize", () => {
  it("aggregates report.appended + output.emitted + state.set across session + stdout", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    // Session-style: emit via the tee sink directly (what PiRunner does).
    await tee.sink.handle({
      type: "state.set",
      timestamp: 1,
      runId: "r",
      checkpoint: { step: 1 },
    });

    // Stdout-style: tool writes a JSON line.
    stdout.write.call(
      null as never,
      '{"type":"report.appended","content":"## Header","timestamp":2}\n',
    );
    stdout.write.call(
      null as never,
      '{"type":"output.emitted","data":{"answer":42},"timestamp":3}\n',
    );
    stdout.write.call(null as never, '{"type":"report.appended","content":"body","timestamp":4}\n');

    // Let the fire-and-forget dispatches resolve.
    await Promise.resolve();
    await Promise.resolve();

    // PiRunner then finalizes with its OWN (incomplete) result — the tee
    // must merge its aggregate into the finalize payload.
    await tee.sink.finalize({
      ...emptyRunResult(),
      status: "success",
      durationMs: 500,
    });

    expect(underlying.finalized).not.toBeNull();
    const final = underlying.finalized!;
    expect(final.report).toBe("## Header\nbody");
    expect(final.output).toEqual({ answer: 42 });
    expect(final.checkpoint).toEqual({ step: 1 });
    expect(final.status).toBe("success");
    expect(final.durationMs).toBe(500);
    tee.restore();
  });

  it("is idempotent — a second finalize call is a no-op (PiRunner + platform synthesis race)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    await tee.sink.finalize({ ...emptyRunResult(), status: "success" });
    const firstFinalized = underlying.finalized;
    await tee.sink.finalize({ ...emptyRunResult(), status: "failed" });

    // The second call did NOT overwrite — finalize is a one-shot terminal.
    expect(underlying.finalized).toBe(firstFinalized);
    expect(underlying.finalized!.status).toBe("success");
    tee.restore();
  });

  it("forwards every handled event to the underlying sink (tee semantics)", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    await tee.sink.handle({
      type: "memory.added",
      timestamp: 1,
      runId: "r",
      content: "m1",
    });
    await tee.sink.handle({
      type: "memory.added",
      timestamp: 2,
      runId: "r",
      content: "m2",
    });

    expect(underlying.handled).toHaveLength(2);
    tee.restore();
  });

  it("aggregates checkpoint.set (AFPS 1.4) into result.checkpoint with scope captured", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    stdout.write.call(
      null as never,
      '{"type":"checkpoint.set","data":{"cursor":"abc"},"scope":"shared","timestamp":1}\n',
    );
    await Promise.resolve();
    await Promise.resolve();

    await tee.sink.finalize({ ...emptyRunResult(), status: "success" });

    const final = underlying.finalized!;
    expect(final.checkpoint).toEqual({ cursor: "abc" });
    expect(final.checkpointScope).toBe("shared");
    tee.restore();
  });

  it("dual-event acceptance: legacy state.set and new checkpoint.set both write into result.checkpoint", async () => {
    const underlying = recordingSink();
    const stdout = makeFakeStdout();
    const tee = attachTeeSink({ sink: underlying, runId: "r", stdout });

    // Old runner emits state.set.
    stdout.write.call(null as never, '{"type":"state.set","state":{"v":1},"timestamp":1}\n');
    // Then a new runner overwrites via checkpoint.set with scope.
    stdout.write.call(
      null as never,
      '{"type":"checkpoint.set","data":{"v":2},"scope":"actor","timestamp":2}\n',
    );
    await Promise.resolve();
    await Promise.resolve();

    await tee.sink.finalize({ ...emptyRunResult(), status: "success" });

    const final = underlying.finalized!;
    expect(final.checkpoint).toEqual({ v: 2 });
    expect(final.checkpointScope).toBe("actor");
    tee.restore();
  });
});
