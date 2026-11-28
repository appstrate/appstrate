// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/conversation-tools.ts` — a conversation's tool calls from its stored messages.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { conversationTools } from "../src/ui/conversation-tools.ts";
import { presentationSubject } from "../src/ui/tool-presentation.ts";

/** An MCP text result, as the chat stores it. */
const mcp = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  ...extra,
});

/**
 * The provider metadata the engine stamps a call's outcome in (`ui-stream-mapper.ts`): its
 * presentation and its duration.
 */
const presented = (presentation: ToolPresentation, outcome: { durationMs?: number } = {}) => ({
  resultProviderMetadata: { appstrate: { presentation, ...outcome } },
});

const GMAIL = {
  kind: "integration",
  id: "@appstrate/gmail",
  display_name: "Gmail",
  icons: [{ src: "https://example.test/gmail.svg" }],
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
            ...presented({ call: "proxied_request", subject: GMAIL }, { durationMs: 7 }),
          }),
          call("live", "get_me", { state: "input-available", input: {} }),
        ]),
      ],
      { running: true },
    );
    expect(calls.map((c) => c.durationMs)).toEqual([42, 7, undefined]);
    expect("durationMs" in calls[2]!).toBe(false);
  });

  it("keeps the presentation of a call, failed or not", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("ok", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ call: "proxied_request", method: "GET", subject: GMAIL }),
        }),
        call("ko", "call_integration_tool", {
          state: "output-error",
          input: { tool: "acme_github__create_issue" },
          errorText: "403 Resource not accessible",
          ...presented({ call: "remote_tool", title: "Create issue", subject: GITHUB }),
        }),
      ]),
    ]);
    expect(calls.map((c) => presentationSubject(c.presentation)?.id)).toEqual([
      "@appstrate/gmail",
      "@acme/github",
    ]);
  });

  it("marks a lookup by the engine's stamp", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("l1", "search", {
          state: "output-available",
          input: { query: "x" },
          output: mcp({ results: [] }),
          callProviderMetadata: { appstrate: { lookup: true } },
        }),
      ]),
    ]);
    expect(calls[0]?.lookup).toBe(true);
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

  it("reads the space a failed call acted in off its outcome", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("c1", "invoke_operation", {
          state: "output-error",
          input: { operation_id: "deleteAgent" },
          errorText: "forbidden",
          callProviderMetadata: { appstrate: { spaceId: "spc_caller" } },
          resultProviderMetadata: { appstrate: { actedSpaceIds: ["spc_target"] } },
        }),
      ]),
    ]);
    expect(calls[0]?.spaceId).toBe("spc_target");
  });

  it("derives a finished message once, whatever array or reader asks", () => {
    const finished = assistant("a1", [
      call("c1", "get_me", { state: "output-available", input: {}, output: mcp({ ok: 1 }) }),
    ]);
    const streaming = (text: string) =>
      assistant("a2", [
        { type: "text", text },
        call("c2", "search", { state: "input-available", input: {} }),
      ]);
    const frame1 = [user("u1"), finished, user("u2"), streaming("a")];
    const first = conversationTools(frame1, { running: true });
    expect(conversationTools(frame1, { running: true })).toBe(first);
    const second = conversationTools([user("u1"), finished, user("u2"), streaming("ab")], {
      running: true,
    });
    expect(second).not.toBe(first);
    expect(second.calls[0]).toBe(first.calls[0]!);
    expect(second.calls[1]).not.toBe(first.calls[1]!);
    expect(second.calls[1]?.status).toBe("running");
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
