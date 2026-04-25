// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { Tool as AfpsTool, RunEvent } from "@afps-spec/types";
import { createInProcessPair, fromAfpsTool } from "../src/index.ts";

function makeAfpsEcho(): AfpsTool {
  return {
    name: "echo",
    description: "Echoes the input message.",
    parameters: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const a = args as { message?: unknown };
      return {
        content: [
          {
            type: "text",
            text: `[${ctx.runId}] ${String(a.message ?? "")}`,
          },
        ],
      };
    },
  };
}

describe("fromAfpsTool — Phase 1 bridge for AFPS-shaped tools", () => {
  it("registers an AFPS Tool through the in-process MCP pair", async () => {
    const tool = fromAfpsTool(makeAfpsEcho(), {
      runId: "run_abc",
      workspace: "/tmp/run_abc",
    });
    const pair = await createInProcessPair([tool]);
    try {
      const list = await pair.client.listTools();
      expect(list.tools).toHaveLength(1);
      expect(list.tools[0]!.name).toBe("echo");
      // AFPS `parameters` flows through unchanged into MCP `inputSchema`.
      expect(list.tools[0]!.inputSchema.required).toEqual(["message"]);

      const result = await pair.client.callTool({
        name: "echo",
        arguments: { message: "hi" },
      });
      expect(result.content).toEqual([{ type: "text", text: "[run_abc] hi" }]);
    } finally {
      await pair.close();
    }
  });

  it("threads the request signal into the AFPS ToolContext", async () => {
    let observedSignal: AbortSignal | undefined;
    const tool: AfpsTool = {
      name: "captures-signal",
      description: "Captures the per-call abort signal for inspection.",
      parameters: { type: "object", additionalProperties: false },
      async execute(_args, ctx) {
        observedSignal = ctx.signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const pair = await createInProcessPair([fromAfpsTool(tool, { runId: "r", workspace: "/tmp" })]);
    try {
      await pair.client.callTool({ name: "captures-signal" });
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      // The SDK's request handler receives a live, non-aborted signal —
      // tools can attach abort listeners during execute() without races.
      expect(observedSignal!.aborted).toBe(false);
    } finally {
      await pair.close();
    }
  });

  it("forwards emit() calls to the configured event sink", async () => {
    const events: RunEvent[] = [];
    const tool: AfpsTool = {
      name: "emits",
      description: "Emits a custom event mid-execution.",
      parameters: { type: "object", additionalProperties: false },
      async execute(_args, ctx) {
        ctx.emit({
          type: "custom.thing",
          timestamp: Date.now(),
          runId: ctx.runId,
        } as RunEvent);
        return { content: [{ type: "text", text: "done" }] };
      },
    };
    const pair = await createInProcessPair([
      fromAfpsTool(tool, {
        runId: "r-emit",
        workspace: "/tmp",
        emit: (event) => events.push(event),
      }),
    ]);
    try {
      await pair.client.callTool({ name: "emits" });
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("custom.thing");
      expect(events[0]!.runId).toBe("r-emit");
    } finally {
      await pair.close();
    }
  });

  it("preserves AFPS isError: true through to the MCP CallToolResult", async () => {
    const tool: AfpsTool = {
      name: "soft-fail",
      description: "Returns a tool-level failure, not a thrown error.",
      parameters: { type: "object", additionalProperties: false },
      async execute() {
        return {
          content: [{ type: "text", text: "Upstream said 503" }],
          isError: true,
        };
      },
    };
    const pair = await createInProcessPair([fromAfpsTool(tool, { runId: "r", workspace: "/tmp" })]);
    try {
      const result = await pair.client.callTool({ name: "soft-fail" });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Upstream said 503" }]);
    } finally {
      await pair.close();
    }
  });

  it("translates AFPS resource references to MCP resource_link blocks", async () => {
    // AFPS spec §8.4 mandates URI references over inline bytes for binary
    // payloads; MCP encodes URI references as `resource_link`, while
    // `resource` is reserved for inline text/blob. The adapter remaps.
    const tool: AfpsTool = {
      name: "returns-uri",
      description: "Returns a URI to a workspace resource.",
      parameters: { type: "object", additionalProperties: false },
      async execute() {
        return {
          content: [
            {
              type: "resource",
              uri: "workspace:///out/report.pdf",
              mimeType: "application/pdf",
            },
          ],
        };
      },
    };
    const pair = await createInProcessPair([fromAfpsTool(tool, { runId: "r", workspace: "/tmp" })]);
    try {
      const result = await pair.client.callTool({ name: "returns-uri" });
      const content = result.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      expect(content[0]).toMatchObject({
        type: "resource_link",
        name: "report.pdf", // basename of the URI path, decoded
        uri: "workspace:///out/report.pdf",
        mimeType: "application/pdf",
      });
    } finally {
      await pair.close();
    }
  });

  it("rejects malformed AFPS parameters with an AFPS-flavoured message", () => {
    // Regression: a malformed AFPS tool used to fail inside
    // createMcpServer with an MCP-flavoured message
    // ("must declare inputSchema with { type: 'object' }"), sending
    // users to the wrong place. fromAfpsTool now surfaces the failure
    // pointing at the AFPS `parameters` field.
    const broken: AfpsTool = {
      name: "broken",
      description: "missing root type",
      // Intentionally not `{ type: "object", … }` — this is what we
      // want to catch at the adapter boundary.
      parameters: { properties: {} } as unknown as Record<string, unknown>,
      async execute() {
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    expect(() => fromAfpsTool(broken, { runId: "run_x", workspace: "/tmp/run_x" })).toThrow(
      /AFPS `parameters`/,
    );
  });

  it("throws an adapter-level error on unknown AFPS content blocks", async () => {
    // If AFPS ever introduces a content discriminant the adapter does
    // not yet know about (or a tool emits a typo), we want the failure
    // surface to be the adapter — clear message, fixable in this file
    // — not the wire, where the SDK rejects with a less actionable
    // schema-validation error.
    const tool: AfpsTool = {
      name: "drift",
      description: "emits an unsupported content block type",
      parameters: { type: "object", additionalProperties: false },
      async execute() {
        return {
          content: [
            // Typed-loose return: AFPS spec only enforces shape at runtime.
            { type: "audio", data: "…" } as unknown as { type: "text"; text: string },
          ],
        };
      },
    };
    const pair = await createInProcessPair([
      fromAfpsTool(tool, { runId: "r", workspace: "/tmp/r" }),
    ]);
    try {
      // The SDK propagates handler throws as JSON-RPC InternalError
      // (-32603) — that's the "runtime fault" path of the AFPS
      // contract, distinct from "business failure" (`isError: true` in
      // a returned result). Adapter drift is a runtime fault.
      await expect(pair.client.callTool({ name: "drift", arguments: {} })).rejects.toThrow(
        /unknown content block type.*audio/,
      );
    } finally {
      await pair.close();
    }
  });
});
