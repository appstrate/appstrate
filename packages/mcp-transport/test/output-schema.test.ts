// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createInProcessPair, type AppstrateToolDefinition } from "../src/index.ts";

const outputSchema = {
  type: "object" as const,
  required: ["done"],
  properties: { done: { type: "boolean" }, ref: { $ref: "#/$defs/Ref" } },
  additionalProperties: false,
  $defs: { Ref: { type: "string" } },
};

function typedTool(result: CallToolResult): AppstrateToolDefinition {
  return {
    descriptor: { name: "typed", inputSchema: { type: "object" }, outputSchema },
    handler: async () => result,
  };
}

/** Calls without `listTools` first, so the SDK client caches no validator: the verdict is the server's. */
async function call(result: CallToolResult): Promise<CallToolResult> {
  const pair = await createInProcessPair([typedTool(result)]);
  try {
    return (await pair.client.callTool({ name: "typed", arguments: {} })) as CallToolResult;
  } finally {
    await pair.close();
  }
}

const text = [{ type: "text" as const, text: "{}" }];

describe("createMcpServer — declared outputSchema", () => {
  it("returns a result whose structuredContent matches", async () => {
    const structuredContent = { done: true, ref: "x" };
    expect((await call({ content: text, structuredContent })).structuredContent).toEqual(
      structuredContent,
    );
  });

  it("refuses a mismatching structuredContent as an internal error", async () => {
    const refused = call({ content: text, structuredContent: { done: "yes", extra: 1 } });
    await expect(refused).rejects.toMatchObject({ code: ErrorCode.InternalError });
    await expect(refused).rejects.toThrow(/outside its outputSchema/);
  });

  it("refuses a success without structuredContent", async () => {
    await expect(call({ content: text })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
    });
  });

  it("leaves an isError result unchecked", async () => {
    const result = await call({ content: text, isError: true });
    expect(result.isError).toBe(true);
  });
});
