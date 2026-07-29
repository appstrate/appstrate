// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { formatDuration } from "@appstrate/core/format";
import { buildLogEntries, buildTurnRows, type RawLog } from "../log-utils";

/** Minimal well-formed per-turn breadcrumb, as the runner emits it. */
function turnLog(data: Record<string, unknown>): RawLog {
  return { type: "progress", level: "debug", event: "progress", message: "Turn 1 — …", data };
}

describe("buildLogEntries — output extraction", () => {
  it("merges output events into the structured output bag", () => {
    const logs: RawLog[] = [
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      { type: "result", level: "info", event: "output", data: { bar: 2 } },
    ];
    const { output } = buildLogEntries(logs);
    expect(output).toEqual({ foo: 1, bar: 2 });
  });

  it("returns null output when no output events are present", () => {
    const logs: RawLog[] = [{ type: "progress", level: "debug", message: "hi" }];
    const { output } = buildLogEntries(logs);
    expect(output).toBeNull();
  });
});

describe("buildLogEntries — historical report rows", () => {
  // The `report` runtime tool is gone; rows written before the removal stay in
  // `run_logs` forever. They must be skipped outright — without the explicit
  // exclusion they fall through to the generic branch and surface as
  // contextless lines in the viewer of every old run.
  it("excludes dead report rows from the viewer entirely", () => {
    const logs: RawLog[] = [
      {
        type: "result",
        level: "info",
        event: "report",
        data: { content: "# Hello\n\nWorld" },
      },
      {
        type: "result",
        level: "info",
        event: "report",
        data: { content: "Second chunk", message: "Tool: report" },
      },
    ];
    const { entries, output } = buildLogEntries(logs);
    expect(entries).toEqual([]);
    expect(output).toBeNull();
  });

  it("keeps surrounding progress rows intact around an excluded report row", () => {
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "before" },
      { type: "result", level: "info", event: "report", data: { content: "# md" } },
      { type: "progress", level: "debug", message: "after" },
    ];
    const { entries } = buildLogEntries(logs);
    // The report row also breaks the plain-text coalescing run, so `before`
    // and `after` stay two distinct entries rather than being merged.
    expect(entries.map((e) => e.message)).toEqual(["before", "after"]);
  });
});

describe("buildLogEntries — progress entry coalescing", () => {
  it("coalesces consecutive data-less progress lines into one entry (agent stdout)", () => {
    // Freeform stdout lines arrive as data-less progress events; folding them
    // into one block keeps the viewer readable instead of N micro-rows.
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "line one" },
      { type: "progress", level: "debug", message: "line two" },
      { type: "progress", level: "debug", message: "line three" },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("line one\nline two\nline three");
  });

  it("keeps data-bearing progress events as distinct entries (boot breadcrumbs)", () => {
    // The runtime-pi boot breadcrumbs carry `data` (at least `{ boot: true }`)
    // precisely so each phase marker stays its own log line rather than being
    // folded into the previous one.
    const logs: RawLog[] = [
      { type: "progress", level: "info", message: "connecting to sidecar", data: { boot: true } },
      { type: "progress", level: "info", message: "MCP connected", data: { boot: true } },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.message)).toEqual(["connecting to sidecar", "MCP connected"]);
  });
});

describe("buildLogEntries — tool durations", () => {
  it("carries `data.durationMs` onto the tool-result entry", () => {
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", result: "ok", isError: false, durationMs: 1450 },
      },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries[0]!.durationMs).toBe(1450);
  });

  it("omits the duration when the runner could not pair the call", () => {
    // The runner emits NO `durationMs` rather than a zero when it never saw the
    // call's start — the entry must not invent one.
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { tool: "read", result: "ok", isError: false },
      },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries[0]!.durationMs).toBeUndefined();
  });

  it("ignores a non-numeric duration", () => {
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "Tool: read", data: { durationMs: "fast" } },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries[0]!.durationMs).toBeUndefined();
  });

  it("formats durations sub-second in ms and above in one-decimal seconds", () => {
    // The viewer renders `LogEntry.durationMs` through the shared
    // `@appstrate/core/format` helper rather than a local copy; this pins the
    // contract the log line depends on.
    expect(formatDuration(842)).toBe("842ms");
    expect(formatDuration(1500)).toBe("1.5s");
  });
});

describe("buildTurnRows — per-turn projection", () => {
  it("parses well-formed turn rows", () => {
    const rows = buildTurnRows([
      turnLog({
        event: "turn",
        index: 1,
        latencyMs: 4200,
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 96000,
        cacheWriteTokens: 800,
        contextTokens: 96920,
        contextWindow: 200000,
        compactionThreshold: 136000,
      }),
    ]);
    expect(rows).toEqual([
      {
        index: 1,
        contextTokens: 96920,
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 96000,
        cacheWriteTokens: 800,
        latencyMs: 4200,
        contextWindow: 200000,
        compactionThreshold: 136000,
      },
    ]);
  });

  it("keeps the window ABSENT rather than zeroed when the runner states none", () => {
    // The denominator of the whole context reading. "Unknown" and "0" are
    // different statements, and a defaulted 0 would be indistinguishable from a
    // runner that genuinely reported one — so the key must simply not be there.
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 1, inputTokens: 10, outputTokens: 5 }),
    ]);
    expect(rows[0]!).not.toHaveProperty("contextWindow");
    expect(rows[0]!).not.toHaveProperty("compactionThreshold");
  });

  it("carries a window with no threshold — auto-compaction off, reported truthfully", () => {
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 1, inputTokens: 10, contextWindow: 1_000_000 }),
    ]);
    expect(rows[0]!.contextWindow).toBe(1_000_000);
    expect(rows[0]!).not.toHaveProperty("compactionThreshold");
  });

  it("drops a malformed window/threshold instead of coercing it", () => {
    const rows = buildTurnRows([
      turnLog({
        event: "turn",
        index: 1,
        inputTokens: 10,
        contextWindow: "200k",
        compactionThreshold: Number.NaN,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).not.toHaveProperty("contextWindow");
    expect(rows[0]!).not.toHaveProperty("compactionThreshold");
  });

  it("ignores rows carrying a different `data.event`", () => {
    const rows = buildTurnRows([
      turnLog({ event: "output_reprompt", index: 1 }),
      { type: "progress", level: "debug", message: "plain narration" },
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      turnLog({ event: "turn", index: 7, inputTokens: 1, outputTokens: 2 }),
    ]);
    expect(rows.map((r) => r.index)).toEqual([7]);
  });

  it("tolerates a missing latencyMs", () => {
    const rows = buildTurnRows([
      turnLog({ event: "turn", index: 3, inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }),
    ]);
    expect(rows[0]!.latencyMs).toBeUndefined();
    // contextTokens falls back to input + cacheRead + cacheWrite when absent.
    expect(rows[0]!.contextTokens).toBe(30);
  });

  it("tolerates malformed or absent data without throwing", () => {
    const rows = buildTurnRows([
      { type: "progress", level: "debug", message: "no data at all" },
      { type: "progress", level: "debug", message: "null data", data: null },
      turnLog({ event: "turn" }), // no index → unplottable
      turnLog({ event: "turn", index: "two" }),
      turnLog({ event: "turn", index: 4, inputTokens: "many", latencyMs: "slow" }),
    ]);
    expect(rows).toEqual([
      {
        index: 4,
        contextTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("returns an empty array for runs predating the breadcrumb", () => {
    expect(buildTurnRows([{ type: "progress", level: "debug", message: "hello" }])).toEqual([]);
  });
});

describe("buildLogEntries — turn breadcrumbs excluded from the stream", () => {
  it("drops turn rows so they do not drown the agent's narration", () => {
    // A heavy run emits ~108 of them; interleaved they bury the real log.
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "before" },
      turnLog({ event: "turn", index: 1, inputTokens: 1, outputTokens: 2 }),
      { type: "progress", level: "debug", message: "after" },
    ];
    const { entries } = buildLogEntries(logs);
    expect(entries.map((e) => e.message)).toEqual(["before", "after"]);
  });

  it("leaves every other row class untouched", () => {
    const logs: RawLog[] = [
      { type: "result", level: "info", event: "output", data: { foo: 1 } },
      { type: "progress", level: "info", message: "MCP connected", data: { boot: true } },
      turnLog({ event: "turn", index: 1, inputTokens: 1, outputTokens: 2 }),
      {
        type: "progress",
        level: "debug",
        message: "Tool: read",
        data: { args: { path: "a.md" }, durationMs: 120 },
      },
      { type: "system", level: "warn", message: "heads up" },
    ];
    const { entries, output } = buildLogEntries(logs);
    expect(output).toEqual({ foo: 1 });
    expect(entries.map((e) => e.message)).toEqual(["MCP connected", "Tool: read", "heads up"]);
    expect(entries[1]!.detail).toBe("path: a.md");
    expect(entries[1]!.durationMs).toBe(120);
    expect(entries[2]!.level).toBe("warn");
  });
});
