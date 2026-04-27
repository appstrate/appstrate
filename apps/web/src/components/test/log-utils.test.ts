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

describe("buildLogEntries — report extraction (`@appstrate/report` tool)", () => {
  // The platform persists every `report.appended` event from the agent as
  // `run_logs(type='result', event='report', data={ content })`. The UI
  // must extract this content as a first-class field — without it the
  // markdown is only visible inside the truncated args of the generic
  // "Tool: report" log line, defeating the whole purpose of the tool.
  it("extracts a single report log into the report field", () => {
    const logs: RawLog[] = [
      {
        type: "result",
        level: "info",
        event: "report",
        data: { content: "# Hello\n\nWorld" },
      },
    ];
    const { report } = buildLogEntries(logs);
    expect(report).toBe("# Hello\n\nWorld");
  });

  it("concatenates multiple report logs in order with newlines", () => {
    const logs: RawLog[] = [
      { type: "result", level: "info", event: "report", data: { content: "## Step 1" } },
      { type: "progress", level: "debug", message: "doing things" },
      { type: "result", level: "info", event: "report", data: { content: "## Step 2" } },
      { type: "result", level: "info", event: "report", data: { content: "## Step 3" } },
    ];
    const { report } = buildLogEntries(logs);
    expect(report).toBe("## Step 1\n## Step 2\n## Step 3");
  });

  it("returns null report when no report logs are present", () => {
    const logs: RawLog[] = [
      { type: "progress", level: "debug", message: "no reports here" },
      { type: "result", level: "info", event: "output", data: { x: 1 } },
    ];
    const { report } = buildLogEntries(logs);
    expect(report).toBeNull();
  });

  it("does NOT confuse a 'Tool: report' progress log with a real report log", () => {
    // This is the exact production shape that *almost* looked like a
    // report but isn't — emitted by the SDK's tool_execution_start
    // bridge, not by the report tool itself. The args carry the markdown
    // but it's not the canonical report channel.
    const logs: RawLog[] = [
      {
        type: "progress",
        level: "debug",
        event: "progress",
        message: "Tool: report",
        data: { tool: "report", args: { content: "should NOT be picked up" } },
      },
    ];
    const { report } = buildLogEntries(logs);
    expect(report).toBeNull();
  });

  it("ignores report logs whose data lacks a string content field", () => {
    const logs: RawLog[] = [
      {
        type: "result",
        level: "info",
        event: "report",
        data: { content: 42 as unknown as string },
      },
      { type: "result", level: "info", event: "report", data: null },
      { type: "result", level: "info", event: "report", data: { content: "real one" } },
    ];
    const { report } = buildLogEntries(logs);
    expect(report).toBe("real one");
  });
});
