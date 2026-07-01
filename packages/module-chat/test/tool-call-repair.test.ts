// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { repairStringifiedToolCall } from "../src/platform-mcp.ts";

function repair(input: string, toolName = "invoke_operation") {
  return repairStringifiedToolCall({
    toolCall: {
      type: "tool-call",
      toolCallId: "call_1",
      toolName,
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

  test("unwraps a direct JSON object string with literal newlines in string fields", async () => {
    const input = `{"kind":"inline","manifest":{"name":"@inline/gmail-summary"},"prompt":"Step 1
Step 2"}`;

    const repaired = await repair(input, "run_and_wait");

    expect(repaired).toMatchObject({
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "run_and_wait",
      input: JSON.stringify({
        kind: "inline",
        manifest: { name: "@inline/gmail-summary" },
        prompt: "Step 1\nStep 2",
      }),
    });
  });

  test("does not rewrite malformed non-object JSON", async () => {
    await expect(repair(JSON.stringify({ operation_id: "runInline" }))).resolves.toBeNull();
    await expect(repair('{"operation_id":')).resolves.toBeNull();
    await expect(repair("[1,2,3]")).resolves.toBeNull();
  });
});
