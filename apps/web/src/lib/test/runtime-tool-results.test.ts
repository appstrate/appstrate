// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { historyRuns, recalledMemories } from "../runtime-tool-results";

const mcp = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

describe("runtime tool results", () => {
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

  it("answers null for anything else, so the caller keeps the JSON", () => {
    expect(recalledMemories({ count: 3 })).toBeNull();
    expect(historyRuns("not json")).toBeNull();
    expect(historyRuns(mcp({ memories: [] }))).toBeNull();
  });
});
