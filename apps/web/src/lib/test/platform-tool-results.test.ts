// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { historyRuns, platformTool, recalledMemories } from "../platform-tool-results";

const mcp = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

describe("platform tool results", () => {
  it("tells a platform tool by the integration identity of the call", () => {
    expect(platformTool({ id: "@appstrate/platform", tool: "recall_memory" })).toBe(
      "recall_memory",
    );
    expect(platformTool({ id: "@acme/memory", tool: "recall_memory" })).toBeUndefined();
    expect(platformTool(undefined)).toBeUndefined();
  });

  it("reads recall_memory from an MCP text part, a string or an object", () => {
    const body = { memories: [{ id: 7, content: "Relevé BNC en CSV", createdAt: "2026-09-01" }] };
    const expected = [{ id: "7", content: "Relevé BNC en CSV", createdAt: "2026-09-01" }];
    expect(recalledMemories(mcp(body))).toEqual(expected);
    expect(recalledMemories(JSON.stringify(body))).toEqual(expected);
    expect(recalledMemories(body)).toEqual(expected);
  });

  it("reads run_history's list envelope", () => {
    const body = { object: "list", data: [{ id: "run_9", status: "success", duration: 12_000 }] };
    expect(historyRuns(mcp(body))).toEqual([
      { id: "run_9", status: "success", date: undefined, duration: 12_000 },
    ]);
  });

  it("reads the structured output when present and falls back to a historical text receipt", () => {
    const memory = {
      id: 7,
      content: "Saved",
      createdAt: "2026-09-01",
      actor_type: "shared",
      actor_id: null,
    };
    expect(recalledMemories({ structuredContent: { memories: [memory] }, content: [] })).toEqual([
      { id: "7", content: "Saved", createdAt: "2026-09-01" },
    ]);
    const run = { id: "run_1", status: "success", date: null, duration: 10 };
    const history = { object: "list", hasMore: false, data: [run] };
    expect(historyRuns({ structuredContent: history, content: [] })).toEqual([
      { id: "run_1", status: "success", date: undefined, duration: 10 },
    ]);
    expect(historyRuns({ structuredContent: { data: "old" }, ...mcp({ data: [run] }) })).toEqual(
      historyRuns(history),
    );
  });

  it("answers null for anything else, so the caller keeps the JSON", () => {
    expect(recalledMemories({ count: 3 })).toBeNull();
    expect(historyRuns("not json")).toBeNull();
    expect(historyRuns(mcp({ memories: [] }))).toBeNull();
  });
});
