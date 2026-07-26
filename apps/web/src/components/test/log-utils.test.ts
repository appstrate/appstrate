// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildLogEntries, type RawLog } from "../log-utils";

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
