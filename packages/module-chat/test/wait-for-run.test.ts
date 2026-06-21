// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ToolSet } from "ai";
import { createWaitForRunTool } from "../src/wait-for-run.ts";

/** Wrap a JSON body as an MCP CallToolResult, the shape `invoke_operation` returns. */
function mcpResult(payload: { status: number; body: unknown }) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Build a fake MCP ToolSet whose `invoke_operation` returns scripted results. */
function fakeMcp(impl: (call: number) => { status: number; body: unknown }): ToolSet {
  let n = 0;
  return {
    invoke_operation: {
      execute: async () => mcpResult(impl(n++)),
    },
  } as unknown as ToolSet;
}

const opts = (signal?: AbortSignal) =>
  ({ toolCallId: "tc", messages: [], abortSignal: signal }) as never;

describe("createWaitForRunTool", () => {
  it("returns the terminal run on the first poll without waiting", async () => {
    const tool = createWaitForRunTool(
      fakeMcp(() => ({ status: 200, body: { status: "success", result: { ok: 1 } } })),
    );
    const out = (await tool.execute!({ run_id: "run_1" }, opts())) as Record<string, unknown>;
    expect(out.status).toBe("success");
    expect(out.run_id).toBe("run_1");
    expect(out.result).toEqual({ ok: 1 });
    expect(out.error).toBeNull();
  });

  it("surfaces a >=400 platform response as an error (never converges)", async () => {
    const tool = createWaitForRunTool(
      fakeMcp(() => ({ status: 404, body: { detail: "not found" } })),
    );
    const out = (await tool.execute!({ run_id: "missing" }, opts())) as Record<string, unknown>;
    expect(out.error).toBe("getRun returned HTTP 404");
    expect(out.detail).toEqual({ detail: "not found" });
  });

  it("returns aborted=true when the signal is already aborted", async () => {
    const tool = createWaitForRunTool(
      fakeMcp(() => ({ status: 200, body: { status: "running" } })),
    );
    const out = (await tool.execute!({ run_id: "run_2" }, opts(AbortSignal.abort()))) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ run_id: "run_2", aborted: true });
  });

  it("errors cleanly when invoke_operation is absent on the session", async () => {
    const tool = createWaitForRunTool({} as ToolSet);
    const out = (await tool.execute!({ run_id: "run_3" }, opts())) as Record<string, unknown>;
    expect(out.error).toContain("invoke_operation tool unavailable");
  });
});
