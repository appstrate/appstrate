// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { repairStringifiedToolCall } from "../src/platform-mcp.ts";

function repair(input: string) {
  return repairStringifiedToolCall({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "invoke_operation",
      input,
    },
    tools: {},
    inputSchema: async () => ({}),
    messages: [],
    system: undefined,
    error: new Error("invalid input"),
  } as never);
}

describe("repairStringifiedToolCall", () => {
  test("unwraps a double-encoded JSON object input", async () => {
    const payload = {
      operation_id: "runInline",
      body: { prompt: "Do the work", manifest: { name: "@inline/t1" } },
    };

    const repaired = await repair(JSON.stringify(JSON.stringify(payload)));

    expect(repaired).toMatchObject({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "invoke_operation",
      input: JSON.stringify(payload),
    });
  });

  test("does not rewrite ordinary object JSON or malformed JSON", async () => {
    await expect(repair(JSON.stringify({ operation_id: "runInline" }))).resolves.toBeNull();
    await expect(repair('{"operation_id":')).resolves.toBeNull();
  });
});
