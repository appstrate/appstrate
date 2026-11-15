// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_INTEGRATION_META_KEY, type CallToolResult } from "@appstrate/mcp-transport";
import { mcpToolForwardFactory, type McpToolForwardOptions } from "../src/mcp-forward.ts";
import { integrationOf } from "../src/tool-integration.ts";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-forward-"));
afterAll(() => fs.rm(workspace, { recursive: true, force: true }));

interface Registered {
  name: string;
  description: string;
  execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/** The tool the factory registers, over a client answering `result`, with what it saw. */
function forward(result: CallToolResult, options: Partial<McpToolForwardOptions> = {}) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const mcp: McpToolForwardOptions["mcp"] = {
    callTool: async (args) => {
      calls.push(args);
      return result;
    },
    readResource: async () => ({ contents: [] }),
  };
  let registered: Registered | undefined;
  mcpToolForwardFactory({
    mcp,
    tool: { name: "docs__search", inputSchema: { type: "object" } },
    runId: "run_1",
    workspace,
    emit: (event) => events.push(event),
    ...options,
  })({ registerTool: (tool: Registered) => (registered = tool) } as never);
  return { tool: registered!, calls, events };
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

describe("mcpToolForwardFactory", () => {
  it("forwards a call to the upstream name, between called and completed events", async () => {
    const { tool, calls, events } = forward(text("found"), { upstreamName: "search" });
    expect(tool.description).toBe("Integration tool: docs__search");
    expect(await tool.execute("call_1", { q: "x" })).toEqual({
      content: [{ type: "text", text: "found" }],
      details: undefined,
    });
    expect(calls).toEqual([{ name: "search", arguments: { q: "x" } }]);
    expect(events.map((e) => [e.type, e.tool, e.toolCallId, e.isError])).toEqual([
      ["integration_tool.called", "docs__search", "call_1", undefined],
      ["integration_tool.completed", "docs__search", "call_1", false],
    ]);
  });

  it("records the integration tool its host stamped on the descriptor, none without one", () => {
    const integration = { id: "@acme/docs", tool: "search", title: "Search" };
    const { tool } = forward(text(""), {
      tool: {
        name: "docs__search",
        inputSchema: { type: "object" },
        _meta: { [TOOL_INTEGRATION_META_KEY]: integration },
      },
    });
    expect(integrationOf(tool)).toEqual(integration);
    expect(integrationOf(forward(text("")).tool)).toBeUndefined();
  });

  it("spills an embedded resource to the workspace", async () => {
    const { tool } = forward({
      content: [{ type: "resource", resource: { uri: "file:///r.txt", text: "body" } }],
    });
    const result = (await tool.execute("call_2", {})) as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("resources/call_2-r.txt");
    expect(await Bun.file(path.join(workspace, "resources/call_2-r.txt")).text()).toBe("body");
  });

  it("ends a call its plan refuses without reaching the server", async () => {
    const { tool, calls, events } = forward(text("unused"), {
      plan: async () => ({ error: "no such file" }),
    });
    await expect(tool.execute("call_3", {})).rejects.toThrow("no such file");
    expect(calls).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "integration_tool.completed", isError: true });
  });

  it("completes a call as an error when the server or the plan throws", async () => {
    const failing = forward(text("unused"), {
      mcp: {
        callTool: async () => {
          throw new Error("connection reset");
        },
        readResource: async () => ({ contents: [] }),
      },
    });
    await expect(failing.tool.execute("call_5", {})).rejects.toThrow("connection reset");
    const planFailing = forward(text("unused"), {
      plan: async () => {
        throw new Error("plan broke");
      },
    });
    await expect(planFailing.tool.execute("call_6", {})).rejects.toThrow("plan broke");
    for (const { events } of [failing, planFailing]) {
      expect(events.map((e) => [e.type, e.isError])).toEqual([
        ["integration_tool.called", undefined],
        ["integration_tool.completed", true],
      ]);
    }
  });

  it("sends the plan's arguments and finishes with its result", async () => {
    const { tool, calls } = forward(text("raw"), {
      plan: async (args) => ({
        args: { ...args, extra: true },
        finish: async (result, toolCallId) => ({
          content: [{ type: "text", text: `${toolCallId}:${result.content.length}` }],
          details: undefined,
        }),
      }),
    });
    expect(await tool.execute("call_4", { q: 1 })).toEqual({
      content: [{ type: "text", text: "call_4:1" }],
      details: undefined,
    });
    expect(calls).toEqual([{ name: "docs__search", arguments: { q: 1, extra: true } }]);
  });
});
