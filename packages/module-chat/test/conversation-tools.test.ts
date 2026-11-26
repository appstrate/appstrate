// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/conversation-tools.ts` — a conversation's tool calls from its stored messages, and
 * `src/ui/tool-presentation.ts`, how each one is named.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { conversationTools } from "../src/ui/conversation-tools.ts";
import { isLookupCall, toolPresentation } from "../src/ui/tool-presentation.ts";

/** An MCP text result, as the chat stores it. */
const mcp = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }] });

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

  it("holds a call with no outcome as running only in the turn being generated", () => {
    const pending = call("p1", "invoke_operation", { state: "input-available", input: {} });
    const messages = [assistant("a1", [pending]), user("u2"), assistant("a2", [pending])];
    expect(conversationTools(messages, true).calls.map((c) => c.status)).toEqual([
      "error",
      "running",
    ]);
    expect(conversationTools(messages, false).calls.map((c) => c.status)).toEqual([
      "error",
      "error",
    ]);
  });

  it("names the integration a call reached from the conversation's own search", () => {
    const { calls, integrations } = conversationTools([
      assistant("a1", [
        call("s1", "search", {
          state: "output-available",
          input: { query: "mail" },
          output: mcp({
            results: [
              {
                kind: "integration_tool",
                tools: [
                  { id: "appstrate_gmail__send", integration_package_id: "@appstrate/gmail" },
                  { id: "appstrate_gmail__list", integration_package_id: "@appstrate/gmail" },
                ],
              },
            ],
          }),
        }),
        call("i1", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__send", arguments: {} },
          output: mcp({ ok: true }),
        }),
        call("i2", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__list", arguments: {} },
          output: mcp({ ok: true }),
        }),
        call("i3", "call_integration_tool", {
          state: "output-available",
          input: { tool: "unlisted__tool", arguments: {} },
          output: mcp({ ok: true }),
        }),
      ]),
    ]);
    expect(calls.map((c) => c.integrationPackageId)).toEqual([
      undefined,
      "@appstrate/gmail",
      "@appstrate/gmail",
      undefined,
    ]);
    expect(integrations).toEqual([{ packageId: "@appstrate/gmail", calls: 2 }]);
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

describe("isLookupCall", () => {
  it("keeps read-only tools and reading operations apart from actions", () => {
    expect(isLookupCall("search", {})).toBe(true);
    expect(isLookupCall("get_me", {})).toBe(true);
    expect(isLookupCall("invoke_operation", { operation_id: "listRuns" })).toBe(true);
    expect(isLookupCall("invoke_operation", { operation_id: "createAgent" })).toBe(false);
    expect(isLookupCall("call_integration_tool", { tool: "x__y" })).toBe(false);
    expect(isLookupCall("run_and_wait", {})).toBe(false);
  });
});

describe("toolPresentation", () => {
  it("names a call by its tool and what it acted on", () => {
    expect(toolPresentation("invoke_operation", { operation_id: "deleteAgent" })).toMatchObject({
      labelKey: "tool.op.delete",
      target: "deleteAgent",
    });
    expect(toolPresentation("run_and_wait", { scope: "@acme", name: "triage" })).toMatchObject({
      labelKey: "tool.op.launch",
      target: "@acme/triage",
    });
    expect(toolPresentation("call_integration_tool", { tool: "acme_crm__find" })).toMatchObject({
      labelKey: "tool.integrationTool",
      target: "acme_crm__find",
    });
    expect(toolPresentation("get_me", {})).toMatchObject({ label: "get_me" });
  });
});
