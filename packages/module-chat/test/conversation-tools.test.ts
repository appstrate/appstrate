// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/conversation-tools.ts` — a conversation's tool calls from its stored messages, and the
 * integrations they reached.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { conversationTools } from "../src/ui/conversation-tools.ts";

/** An MCP text result, as the chat stores it. */
const mcp = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  ...extra,
});

/**
 * The provider metadata the engine stamps a call's outcome in (`ui-stream-mapper.ts`): its
 * presentation, and whether its integration answered (`answered`, `pi-chat/mcp-tools.ts`).
 */
const presented = (
  presentation: ToolPresentation,
  outcome: { answered?: true; durationMs?: number } = {},
) => ({
  resultProviderMetadata: { appstrate: { presentation, ...outcome } },
});
const ANSWERED = { answered: true } as const;

const GMAIL = {
  kind: "integration",
  id: "@appstrate/gmail",
  display_name: "Gmail",
  icon: "https://example.test/gmail.svg",
} as const;
const GITHUB = { kind: "integration", id: "@acme/github", display_name: "GitHub" } as const;

const user = (id: string) =>
  ({ id, role: "user", parts: [{ type: "text", text: "hi" }] }) as UIMessage;

function assistant(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as UIMessage;
}

const call = (toolCallId: string, toolName: string, fields: Record<string, unknown>) => ({
  type: `tool-${toolName}`,
  toolCallId,
  ...fields,
});

describe("conversationTools", () => {
  it("lists every call in order, numbered by its assistant turn", () => {
    const { calls } = conversationTools([
      user("u1"),
      assistant("a1", [
        { type: "text", text: "ok" },
        call("c1", "get_me", { state: "output-available", input: {}, output: mcp({ ok: 1 }) }),
      ]),
      user("u2"),
      assistant("a2", [
        call("c2", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "createAgent" },
          output: mcp({ status: 201, body: {} }),
        }),
      ]),
    ]);
    expect(calls.map((c) => [c.toolCallId, c.messageId, c.turn, c.toolName])).toEqual([
      ["c1", "a1", 1, "get_me"],
      ["c2", "a2", 2, "invoke_operation"],
    ]);
    expect(calls[1]?.output).toEqual({ status: 201, body: {} });
  });

  it("reads a failure from the error text, the failure payload or a denial", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("e1", "run_and_wait", { state: "output-error", input: {}, errorText: "boom" }),
        call("e2", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "deleteAgent" },
          output: mcp({ status: 403, body: { detail: "Refusé" } }),
        }),
        call("d1", "invoke_operation", { state: "output-denied", input: {} }),
      ]),
    ]);
    expect(calls.map((c) => [c.status, c.error])).toEqual([
      ["error", "boom"],
      ["error", "Refusé"],
      ["denied", undefined],
    ]);
  });

  it("holds a call with no outcome as cut short once its turn ended", () => {
    const { calls } = conversationTools([
      user("u1"),
      assistant("a1", [call("p1", "invoke_operation", { state: "input-available", input: {} })]),
    ]);
    expect(calls.map((c) => c.status)).toEqual(["error"]);
  });

  it("holds a call with no outcome, or a preliminary one, as running while its turn runs", () => {
    const messages = [
      assistant("a1", [call("old", "invoke_operation", { state: "input-available", input: {} })]),
      user("u2"),
      assistant("a2", [
        call("p1", "invoke_operation", { state: "input-streaming", input: {} }),
        call("p2", "run_and_wait", {
          state: "output-available",
          input: {},
          output: mcp({ id: "run_1", status: "running" }),
          preliminary: true,
        }),
      ]),
    ];
    // Only the last turn is in flight: the earlier call was cut when its own turn ended.
    expect(conversationTools(messages, { running: true }).calls.map((c) => c.status)).toEqual([
      "error",
      "running",
      "running",
    ]);
    expect(conversationTools(messages).calls.map((c) => c.status)).toEqual([
      "error",
      "error",
      "error",
    ]);
  });

  it("reads how long a call ran off its outcome, absent while it runs", () => {
    const { calls } = conversationTools(
      [
        assistant("a1", [
          call("done", "get_me", {
            state: "output-available",
            input: {},
            output: mcp({ ok: 1 }),
            resultProviderMetadata: { appstrate: { durationMs: 42 } },
          }),
          call("failed", "call_integration_tool", {
            state: "output-error",
            input: {},
            errorText: "boom",
            ...presented({ title: "x", subject: GMAIL }, { durationMs: 7 }),
          }),
          call("live", "get_me", { state: "input-available", input: {} }),
        ]),
      ],
      { running: true },
    );
    expect(calls.map((c) => c.durationMs)).toEqual([42, 7, undefined]);
    expect("durationMs" in calls[2]!).toBe(false);
  });

  it("reads a refusal's message off its error text, never its JSON", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("r", "call_integration_tool", {
          state: "output-error",
          input: {},
          errorText: JSON.stringify({ code: "missing_argument", error: "method is required." }),
        }),
      ]),
    ]);
    expect(calls[0]?.error).toBe("method is required.");
  });

  it("keeps the presentation of a call, failed or not", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("ok", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", method: "GET", subject: GMAIL }),
        }),
        call("ko", "call_integration_tool", {
          state: "output-error",
          input: { tool: "acme_github__create_issue" },
          errorText: "403 Resource not accessible",
          ...presented({ title: "Create issue", subject: GITHUB }),
        }),
      ]),
    ]);
    expect(calls.map((c) => c.presentation?.subject?.id)).toEqual([
      "@appstrate/gmail",
      "@acme/github",
    ]);
  });

  it("counts an integration that answered a call, success or failure upstream, once each", () => {
    const { integrations } = conversationTools([
      assistant("a1", [
        call("i1", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", method: "GET", subject: GMAIL }, ANSWERED),
        }),
        // The integration's own failure, relayed.
        call("i2", "call_integration_tool", {
          state: "output-error",
          input: { tool: "acme_github__create_issue" },
          errorText: "403 Resource not accessible",
          ...presented({ title: "Create issue", subject: GITHUB }, ANSWERED),
        }),
        // Whatever its payload carries, a call the engine stamped answered is the integration's.
        call("i3", "call_integration_tool", {
          state: "output-available",
          input: { tool: "acme_github__get_issue" },
          output: mcp({ code: "not_found" }, { relayed: true }),
          ...presented({ title: "Get issue", subject: GITHUB }, ANSWERED),
        }),
        call("i4", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", method: "DELETE", subject: GMAIL }, ANSWERED),
        }),
      ]),
    ]);
    expect(integrations).toEqual([GMAIL, GITHUB]);
  });

  it("counts no integration for a refusal, a denial, an operation or an unpresented call", () => {
    const { integrations } = conversationTools([
      assistant("a1", [
        // The platform refused the arguments: nothing was sent, nothing stamped it answered.
        call("r1", "call_integration_tool", {
          state: "output-error",
          input: { tool: "appstrate_gmail__api_call" },
          errorText: JSON.stringify({ code: "missing_argument", error: "method is required." }),
          ...presented({ title: "API call", subject: GMAIL }),
        }),
        // A success the engine did not stamp answered is not counted either.
        call("r5", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", subject: GMAIL }),
        }),
        call("r2", "call_integration_tool", {
          state: "output-denied",
          input: { tool: "appstrate_gmail__api_call" },
          ...presented({ title: "API call", subject: GMAIL }),
        }),
        call("r3", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "getIntegration" },
          output: mcp({ status: 200, body: {} }),
          ...presented({ title: "Get", method: "GET", tag: "Integrations", subject: GMAIL }),
        }),
        call("r4", "call_integration_tool", {
          state: "output-available",
          input: { tool: "unlisted__tool" },
          output: mcp({ ok: true }),
        }),
      ]),
    ]);
    expect(integrations).toEqual([]);
  });

  it("counts a lookup by the engine's stamp or a read presentation, and never a failed one", () => {
    const lookup = { callProviderMetadata: { appstrate: { lookup: true } } };
    const { calls } = conversationTools([
      assistant("a1", [
        call("l1", "search", {
          state: "output-available",
          input: { query: "x" },
          output: mcp({ results: [] }),
          ...lookup,
        }),
        call("l2", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "listRuns" },
          output: mcp({ status: 200 }),
        }),
        call("l3", "describe", {
          state: "output-available",
          input: { id: "x" },
          output: mcp({ status: 404, error: "nope" }),
          ...lookup,
        }),
        call("l4", "search", { state: "output-error", input: {}, errorText: "boom", ...lookup }),
        call("l5", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "listRuns" },
          output: mcp({ status: 200 }),
          ...presented({ title: "List runs", method: "GET", tag: "Runs" }),
        }),
        call("l6", "invoke_operation", {
          state: "output-error",
          input: { operation_id: "listRuns" },
          errorText: "boom",
          ...presented({ title: "List runs", method: "GET", tag: "Runs" }),
        }),
      ]),
    ]);
    expect(calls.map((c) => [c.status, c.lookup])).toEqual([
      ["success", true],
      ["success", false],
      ["error", false],
      ["error", false],
      ["success", true],
      ["error", false],
    ]);
  });

  it("reads the space a call acted in from its stamp", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("c1", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "listRuns" },
          output: mcp({ status: 200 }),
          callProviderMetadata: { appstrate: { spaceId: "spc_team" } },
        }),
      ]),
    ]);
    expect(calls[0]?.spaceId).toBe("spc_team");
  });

  it("names the run a call launched, bare or in its envelope, and no id of another family", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("c1", "run_and_wait", {
          state: "output-available",
          input: {},
          output: mcp({ id: "run_1", status: "success" }),
        }),
        call("c2", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "runAgent" },
          output: mcp({ status: 201, body: { id: "run_2", status: "pending" } }),
        }),
        call("c3", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "getConnection" },
          output: mcp({ status: 200, body: { id: "conn_1" } }),
        }),
      ]),
    ]);
    expect(calls.map((c) => c.runId)).toEqual(["run_1", "run_2", undefined]);
    expect("runId" in calls[2]!).toBe(false);
  });
});
