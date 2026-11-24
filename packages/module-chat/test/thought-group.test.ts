// SPDX-License-Identifier: Apache-2.0

/**
 * Which parts of an assistant turn fold into the thought block
 * (`thought-group.ts`): reasoning and the agent's tool calls do, errors
 * included; the cards the user acts on or reads stay out.
 */

import { describe, expect, it } from "bun:test";
import {
  INITIATE_CONNECT_OP,
  THOUGHT_GROUP,
  groupThought,
  isStandaloneToolCall,
} from "../src/ui/thought-group.ts";

const complete = { type: "complete" } as const;
const mcp = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });
const call = (toolName: string, args: unknown = {}, rest: Record<string, unknown> = {}) => ({
  type: "tool-call",
  toolName,
  args,
  status: complete,
  ...rest,
});

describe("thought block grouping", () => {
  it("folds reasoning and an ordinary tool call", () => {
    expect(groupThought({ type: "reasoning" })).toEqual([THOUGHT_GROUP]);
    expect(
      groupThought(call("search", { query: "agents" }, { result: mcp({ items: [] }) })),
    ).toEqual([THOUGHT_GROUP]);
  });

  it("folds a failed call: the agent works past it", () => {
    expect(groupThought(call("describe", {}, { isError: true, result: "device_busy" }))).toEqual([
      THOUGHT_GROUP,
    ]);
    const failedCreate = call(
      "invoke_operation",
      { operation_id: "createAgent" },
      { result: mcp({ status: 409, body: { detail: "exists" } }) },
    );
    expect(groupThought(failedCreate)).toEqual([THOUGHT_GROUP]);
  });

  it("leaves text and other parts alone", () => {
    expect(groupThought({ type: "text" })).toBeNull();
    expect(groupThought({ type: "image" })).toBeNull();
  });

  it("keeps the connect card and the run cards out of the block from the first frame", () => {
    const running = { status: { type: "running" } };
    expect(
      isStandaloneToolCall(
        call("invoke_operation", { operation_id: INITIATE_CONNECT_OP }, running),
      ),
    ).toBe(true);
    expect(
      isStandaloneToolCall(call("invoke_operation", { operation_id: "runAgent" }, running)),
    ).toBe(true);
    expect(isStandaloneToolCall(call("run_and_wait", {}, running))).toBe(true);
  });

  it("keeps a created package out of the block once the call succeeds", () => {
    const created = call(
      "invoke_operation",
      { operation_id: "createAgent" },
      { result: mcp({ status: 201, body: { id: "@acme/report" } }) },
    );
    expect(isStandaloneToolCall(created)).toBe(true);
    const imported = call(
      "import_package_file",
      {},
      {
        result: mcp({ root_package_id: "@acme/report", root_type: "agent" }),
      },
    );
    expect(isStandaloneToolCall(imported)).toBe(true);
    // Still running: nothing created yet, it is a step.
    expect(
      isStandaloneToolCall(
        call("invoke_operation", { operation_id: "createAgent" }, { status: { type: "running" } }),
      ),
    ).toBe(false);
  });

  it("keeps a call waiting for the user out of the block", () => {
    expect(isStandaloneToolCall(call("search", {}, { status: { type: "requires-action" } }))).toBe(
      true,
    );
  });
});
