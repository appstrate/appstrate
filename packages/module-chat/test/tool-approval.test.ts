// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's human-approval gate (`tool-approval.ts`): reads pass, writes wait
 * for the host's answer, a refusal blocks with its reason, and the turn ending
 * without an answer refuses (`approval-registry.ts`).
 */

import { describe, it, expect } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { createToolApprovalExtension, type RequestApproval } from "../src/pi-chat/tool-approval.ts";
import { awaitApproval, resolveApproval, type ApprovalDecision } from "../src/approval-registry.ts";

type ToolCallHandler = (event: {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => Promise<{ block?: boolean; reason?: string } | undefined>;

const TOOLS = [
  {
    name: "search_operations",
    inputSchema: { type: "object" as const },
    annotations: { readOnlyHint: true },
  },
  {
    name: "invoke_operation",
    inputSchema: { type: "object" as const },
    annotations: { readOnlyHint: false },
  },
  {
    name: "run_and_wait",
    inputSchema: { type: "object" as const },
    annotations: { readOnlyHint: false, title: "Run and wait" },
  },
];

/** `describe_operation` as the MCP server answers it: the payload as JSON text. */
function describeResult(method: string, summary: string) {
  return { content: [{ type: "text", text: JSON.stringify({ method, summary }) }] };
}

function gate(opts: {
  requestApproval: RequestApproval;
  operations?: Record<string, { method: string; summary: string }>;
}): { handler: ToolCallHandler; described: string[] } {
  const described: string[] = [];
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (event: string, h: ToolCallHandler) => {
      if (event === "tool_call") handler = h;
    },
  } as unknown as ExtensionAPI;
  createToolApprovalExtension({
    tools: TOOLS,
    describeOperation: async (operationId) => {
      described.push(operationId);
      const op = opts.operations?.[operationId];
      if (!op) throw new Error(`Unknown operationId: ${operationId}`);
      return describeResult(op.method, op.summary);
    },
    requestApproval: opts.requestApproval,
  })(pi);
  return { handler: handler!, described };
}

const call = (toolName: string, input: Record<string, unknown> = {}) => ({
  type: "tool_call" as const,
  toolCallId: `call_${toolName}`,
  toolName,
  input,
});

const neverAsked: RequestApproval = () => {
  throw new Error("approval must not be requested");
};

describe("tool approval gate", () => {
  it("lets a read-only tool through without asking", async () => {
    const { handler } = gate({ requestApproval: neverAsked });
    expect(await handler(call("search_operations", { query: "agents" }))).toBeUndefined();
  });

  it("lets a GET operation through without asking, describing it once per turn", async () => {
    const { handler, described } = gate({
      requestApproval: neverAsked,
      operations: { listAgents: { method: "GET", summary: "List agents" } },
    });
    expect(await handler(call("invoke_operation", { operation_id: "listAgents" }))).toBeUndefined();
    expect(await handler(call("invoke_operation", { operation_id: "listAgents" }))).toBeUndefined();
    expect(described).toEqual(["listAgents"]);
  });

  it("holds a writing operation until the person answers, then lets it run", async () => {
    let answer: ((d: ApprovalDecision) => void) | undefined;
    const asked: Array<{ toolCallId: string; reason: string }> = [];
    const { handler } = gate({
      requestApproval: (request) => {
        asked.push(request);
        return new Promise((resolve) => (answer = resolve));
      },
      operations: { updateAgent: { method: "PUT", summary: "Update an agent" } },
    });

    let settled = false;
    const pending = handler(call("invoke_operation", { operation_id: "updateAgent" })).then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    expect(asked).toEqual([{ toolCallId: "call_invoke_operation", reason: "Update an agent" }]);

    answer!({ approved: true });
    expect(await pending).toBeUndefined();
  });

  it("asks for a non-read-only tool, labelled by its MCP title", async () => {
    const asked: string[] = [];
    const { handler } = gate({
      requestApproval: async ({ reason }) => {
        asked.push(reason);
        return { approved: true };
      },
    });
    expect(await handler(call("run_and_wait", { agent: "@acme/x" }))).toBeUndefined();
    expect(asked).toEqual(["Run and wait"]);
  });

  it("asks when the operation cannot be described", async () => {
    const asked: string[] = [];
    const { handler } = gate({
      requestApproval: async ({ reason }) => {
        asked.push(reason);
        return { approved: true };
      },
    });
    await handler(call("invoke_operation", { operation_id: "madeUp" }));
    expect(asked).toEqual(["invoke_operation"]);
  });

  it("blocks a refused call and hands the reason to the model", async () => {
    const { handler } = gate({
      requestApproval: async () => ({ approved: false, reason: "test only, change nothing" }),
      operations: { updateAgent: { method: "PATCH", summary: "Update an agent" } },
    });
    const result = await handler(call("invoke_operation", { operation_id: "updateAgent" }));
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("test only, change nothing");
  });
});

describe("approval registry", () => {
  it("resolves the waiting turn with the person's answer", async () => {
    const turn = new AbortController();
    const waiting = awaitApproval("apr_1", "chs_1", turn.signal);
    expect(resolveApproval("apr_1", "chs_1", { approved: false, reason: "no" })).toBe(true);
    expect(await waiting).toEqual({ approved: false, reason: "no" });
    // Answered once: the id is gone.
    expect(resolveApproval("apr_1", "chs_1", { approved: true })).toBe(false);
  });

  it("refuses an answer sent through another session", async () => {
    const turn = new AbortController();
    const waiting = awaitApproval("apr_2", "chs_owner", turn.signal);
    expect(resolveApproval("apr_2", "chs_other", { approved: true })).toBe(false);
    turn.abort();
    expect(await waiting).toEqual({ approved: false });
  });

  it("refuses when the turn ends without an answer (deadline or stop)", async () => {
    const turn = new AbortController();
    const waiting = awaitApproval("apr_3", "chs_1", turn.signal);
    turn.abort();
    expect(await waiting).toEqual({ approved: false });
    expect(resolveApproval("apr_3", "chs_1", { approved: true })).toBe(false);
  });
});
