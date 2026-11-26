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

/** The provider metadata the engine stamps a presentation in (`ui-stream-mapper.ts`). */
const presented = (presentation: ToolPresentation) => ({
  resultProviderMetadata: { appstrate: { presentation } },
});

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

  it("holds a stored call with no outcome as cut short, in the last turn too", () => {
    // The assistant message is stored when its turn ends: a call kept without an outcome is one
    // the turn's end cut, never one still running.
    const { calls } = conversationTools([
      user("u1"),
      assistant("a1", [call("p1", "invoke_operation", { state: "input-available", input: {} })]),
    ]);
    expect(calls.map((c) => c.status)).toEqual(["error"]);
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

  it("counts an integration the calls reached, success or failure upstream, once each", () => {
    const { integrations } = conversationTools([
      assistant("a1", [
        call("i1", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", method: "GET", subject: GMAIL }),
        }),
        // The integration's own failure, relayed.
        call("i2", "call_integration_tool", {
          state: "output-error",
          input: { tool: "acme_github__create_issue" },
          errorText: "403 Resource not accessible",
          ...presented({ title: "Create issue", subject: GITHUB }),
        }),
        // A relayed result whose own payload carries a `code` is still the integration's.
        call("i3", "call_integration_tool", {
          state: "output-available",
          input: { tool: "acme_github__get_issue" },
          output: mcp({ code: "not_found" }, { relayed: true }),
          ...presented({ title: "Get issue", subject: GITHUB }),
        }),
        call("i4", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ results: [{ status: 200 }] }),
          ...presented({ title: "API call", method: "DELETE", subject: GMAIL }),
        }),
      ]),
    ]);
    expect(integrations).toEqual([GMAIL, GITHUB]);
  });

  it("counts no integration for a refusal, a denial, an operation or an unpresented call", () => {
    const { integrations } = conversationTools([
      assistant("a1", [
        // The platform refused the arguments: nothing was sent.
        call("r1", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__api_call" },
          output: mcp({ code: "missing_argument", error: "arguments.method is required." }),
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

  it("counts a lookup by the engine's stamp, and never a failed one", () => {
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
      ]),
    ]);
    expect(calls.map((c) => [c.status, c.lookup])).toEqual([
      ["success", true],
      ["success", false],
      ["error", false],
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
});
