// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  CHAT_TOOL_STEP_BUDGET,
  CHAT_TOOL_STEP_BUDGET_DENIAL,
} from "@appstrate/core/chat-turn-metadata";
import { buildRunAndWaitCanUseTool } from "../../src/claude-agent/engine.ts";

describe("buildRunAndWaitCanUseTool", () => {
  it("pre-launches and allows tools before the reserved final budget turn", async () => {
    const calls: Array<{ toolName: string; input: Record<string, unknown>; toolUseID?: string }> =
      [];
    const canUseTool = buildRunAndWaitCanUseTool(
      {
        handleToolPermission: (toolName, input, toolUseID) => {
          calls.push({ toolName, input, toolUseID });
        },
      },
      {
        currentTurnCount: () => CHAT_TOOL_STEP_BUDGET - 1,
        markToolStepBudgetReached: () => {
          throw new Error("should not mark the tool budget before the reserved turn");
        },
      },
    );

    const result = await canUseTool?.(
      "mcp__appstrate_chat__run_and_wait",
      { kind: "agent", scope: "@acme", name: "writer" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    );

    // `updatedInput` must echo the input: the CLI's runtime Zod schema requires
    // it on allow responses even though the SDK TS type marks it optional.
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { kind: "agent", scope: "@acme", name: "writer" },
      toolUseID: "toolu_1",
    });
    expect(calls).toEqual([
      {
        toolName: "mcp__appstrate_chat__run_and_wait",
        input: { kind: "agent", scope: "@acme", name: "writer" },
        toolUseID: "toolu_1",
      },
    ]);
  });

  it("denies tools at the reserved final budget turn and marks metadata", async () => {
    let marked = false;
    const calls: unknown[] = [];
    const canUseTool = buildRunAndWaitCanUseTool(
      {
        handleToolPermission: (...args) => {
          calls.push(args);
        },
      },
      {
        currentTurnCount: () => CHAT_TOOL_STEP_BUDGET,
        markToolStepBudgetReached: () => {
          marked = true;
        },
      },
    );

    const result = await canUseTool?.(
      "mcp__platform__invoke_operation",
      { operationId: "GET /api/runs" },
      { signal: new AbortController().signal, toolUseID: "toolu_2" },
    );

    expect(result).toEqual({
      behavior: "deny",
      message: CHAT_TOOL_STEP_BUDGET_DENIAL,
      toolUseID: "toolu_2",
    });
    expect(marked).toBe(true);
    expect(calls).toEqual([]);
  });

  it("does not install a permission hook when no bridge exists", () => {
    expect(
      buildRunAndWaitCanUseTool(null, {
        currentTurnCount: () => 0,
        markToolStepBudgetReached: () => {},
      }),
    ).toBeUndefined();
  });
});
