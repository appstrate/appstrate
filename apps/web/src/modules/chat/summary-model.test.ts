// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { ConversationToolCall } from "@appstrate/module-chat/conversation-tools";
import { isIntegrationCall, summaryModel } from "./summary-model";

let seq = 0;
function call(overrides: Partial<ConversationToolCall> = {}): ConversationToolCall {
  seq += 1;
  return {
    toolCallId: `call_${seq}`,
    messageId: "msg_1",
    turn: 1,
    toolName: "call_integration_tool",
    input: {},
    output: {},
    status: "success",
    lookup: false,
    ...overrides,
  };
}

const run = (id: string) => ({ id });
const counted = <T>(rows: T[], total = rows.length) => ({ rows, total });

describe("summaryModel", () => {
  it("leaves every section out of a conversation that did nothing", () => {
    expect(
      summaryModel({ calls: [], runs: counted([]), files: { rows: [], hasMore: false } }),
    ).toEqual({ runs: null, files: null, integrationCalls: null });
  });

  it("counts the runs with the server's total, not the rows it read", () => {
    const rows = [run("run_3"), run("run_2"), run("run_1")];
    expect(summaryModel({ calls: [], runs: counted(rows, 240) }).runs).toEqual({
      rows,
      total: 240,
      more: true,
    });
    expect(summaryModel({ calls: [], runs: counted(rows) }).runs?.more).toBe(false);
  });

  it("counts no files: whether more follow is the server's `hasMore`", () => {
    const rows = [{ id: "file_1" }];
    expect(summaryModel({ calls: [], files: { rows, hasMore: true } }).files).toEqual({
      rows,
      more: true,
    });
    expect(summaryModel({ calls: [], files: { rows, hasMore: false } }).files?.more).toBe(false);
  });

  it("lists the integration calls latest first, lookups included, with their count", () => {
    const calls = [call(), call({ lookup: true }), call(), call(), call()];
    const group = summaryModel({ calls }).integrationCalls;
    expect(group?.total).toBe(5);
    expect(group?.more).toBe(true);
    expect(group?.rows).toEqual([calls[4]!, calls[3]!, calls[2]!]);
  });

  it("leaves the platform's own calls out", () => {
    const integration = call();
    const calls = [
      call({ toolName: "run_and_wait", runId: "run_1" }),
      call({ toolName: "search", lookup: true }),
      call({ toolName: "invoke_operation" }),
      integration,
    ];
    expect(isIntegrationCall(integration)).toBe(true);
    expect(isIntegrationCall(calls[0]!)).toBe(false);
    expect(summaryModel({ calls }).integrationCalls?.rows).toEqual([integration]);
    expect(summaryModel({ calls: calls.slice(0, 3) }).integrationCalls).toBeNull();
  });

  it("leaves out a group whose list the reader cannot read", () => {
    const model = summaryModel({ calls: [call()] });
    expect(model.runs).toBeNull();
    expect(model.files).toBeNull();
    expect(model.integrationCalls?.rows).toHaveLength(1);
  });
});
