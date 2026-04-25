// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  createInProcessPair,
  createMcpServer,
  type AppstrateToolDefinition,
} from "../src/index.ts";

function echoTool(): AppstrateToolDefinition {
  return {
    descriptor: {
      name: "echo",
      description: "Returns the input message verbatim.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    handler: async (args) => ({
      content: [{ type: "text", text: String(args.message ?? "") }],
    }),
  };
}

describe("createInProcessPair — round-trip via SDK Client/Server", () => {
  it("dispatches tools/list with the registered descriptor", async () => {
    const pair = await createInProcessPair([echoTool()]);
    try {
      const result = await pair.client.listTools();
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]!.name).toBe("echo");
      expect(result.tools[0]!.inputSchema.required).toEqual(["message"]);
    } finally {
      await pair.close();
    }
  });

  it("dispatches tools/call to the matching handler", async () => {
    const pair = await createInProcessPair([echoTool()]);
    try {
      const result = await pair.client.callTool({
        name: "echo",
        arguments: { message: "hello" },
      });
      expect(result.content).toEqual([{ type: "text", text: "hello" }]);
      expect(result.isError).toBeUndefined();
    } finally {
      await pair.close();
    }
  });

  it("returns isError: true for tool-level errors without throwing on the client", async () => {
    // Tool-level errors are *data* the model should see, not protocol errors.
    // The SDK preserves this distinction: handler returns CallToolResult
    // with isError set, the client receives it as a normal response.
    const pair = await createInProcessPair([
      {
        descriptor: { name: "fails", inputSchema: { type: "object" } },
        handler: async () => ({
          content: [{ type: "text", text: "Upstream returned 503" }],
          isError: true,
        }),
      },
    ]);
    try {
      const result = await pair.client.callTool({ name: "fails" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Upstream returned 503" }]);
    } finally {
      await pair.close();
    }
  });

  it("surfaces unknown tool names as a JSON-RPC McpError on the client", async () => {
    const pair = await createInProcessPair([echoTool()]);
    let caught: unknown;
    try {
      await pair.client.callTool({ name: "does-not-exist" });
    } catch (err) {
      caught = err;
    } finally {
      await pair.close();
    }
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.MethodNotFound);
    expect((caught as McpError).message).toContain("does-not-exist");
  });

  it("surfaces handler-thrown exceptions through MCP error semantics", async () => {
    // The SDK auto-wraps handler throws into a JSON-RPC error response so
    // the agent loop can decide whether to retry or surface the failure.
    const pair = await createInProcessPair([
      {
        descriptor: { name: "explodes", inputSchema: { type: "object" } },
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    ]);
    let caught: unknown;
    try {
      await pair.client.callTool({ name: "explodes" });
    } catch (err) {
      caught = err;
    } finally {
      await pair.close();
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("kaboom");
  });

  it("close() shuts both transports and is safe to call once", async () => {
    const pair = await createInProcessPair([echoTool()]);
    await pair.close();
    // After close, listTools should fail — the transport is gone.
    let caught: unknown;
    try {
      await pair.client.listTools();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("createMcpServer — registration validation", () => {
  it("rejects duplicate tool names eagerly", () => {
    expect(() =>
      createMcpServer([
        {
          descriptor: { name: "a", inputSchema: { type: "object" } },
          handler: async () => ({ content: [] }),
        },
        {
          descriptor: { name: "a", inputSchema: { type: "object" } },
          handler: async () => ({ content: [] }),
        },
      ]),
    ).toThrow(/duplicate/);
  });

  it("returns a Server that lists zero tools when registry is empty", async () => {
    const pair = await createInProcessPair([]);
    try {
      const result = await pair.client.listTools();
      expect(result.tools).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it("rejects tool names with whitespace or control characters", () => {
    // The MCP spec leaves the regex unstated, but every reference client
    // we've audited rejects whitespace; permitting it produces names that
    // round-trip badly through generated SDK symbols.
    expect(() =>
      createMcpServer([
        {
          descriptor: { name: "has space", inputSchema: { type: "object" } },
          handler: async () => ({ content: [] }),
        },
      ]),
    ).toThrow(/tool name must match/);
  });

  it("rejects empty tool names", () => {
    expect(() =>
      createMcpServer([
        {
          descriptor: { name: "", inputSchema: { type: "object" } },
          handler: async () => ({ content: [] }),
        },
      ]),
    ).toThrow(/tool name must match/);
  });

  it("rejects descriptors whose inputSchema root type is not 'object'", () => {
    // The MCP spec (2025-06-18+) requires `inputSchema` to be a JSON
    // Schema object whose root type is `"object"`. Catch this at
    // registration so misuse cannot drift into a `tools/call` failure.
    expect(() =>
      createMcpServer([
        {
          descriptor: {
            name: "bad",
            // Cast: TS would otherwise refuse the malformed shape. We
            // exercise the runtime guard, not the compile-time one.
            inputSchema: { type: "string" } as never,
          },
          handler: async () => ({ content: [] }),
        },
      ]),
    ).toThrow(/inputSchema with \{ type: "object" \}/);
  });
});
