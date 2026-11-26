// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/conversation-tools.ts` — a conversation's tool calls from its stored messages, and
 * `showCall` (`src/ui/tool-presentation.ts`), how each one is named.
 */

import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { conversationTools } from "../src/ui/conversation-tools.ts";
import { showCall } from "../src/ui/tool-presentation.ts";

/** An MCP text result, as the chat stores it. */
const mcp = (payload: unknown, presentation?: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  ...(presentation ? { presentation } : {}),
});

const GMAIL = {
  kind: "integration",
  id: "@appstrate/gmail",
  display_name: "Gmail",
  icon: "https://example.test/gmail.svg",
} as const;

/** The presentation the platform stamps on a Gmail tool call. */
const gmailTool = (title: string) => ({
  title,
  subject: GMAIL,
});

/** Keys back, with their params when given: enough to see which one a label used. */
const t = (key: string, params?: Record<string, unknown>) =>
  typeof params?.defaultValue === "string" ? `${key}|${params.defaultValue}` : key;

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

  it("names the integration a call reached from its presentation", () => {
    const { calls, integrations } = conversationTools([
      assistant("a1", [
        call("i1", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__send", arguments: {} },
          output: mcp({ ok: true }, gmailTool("Send")),
        }),
        call("i2", "call_integration_tool", {
          state: "output-available",
          input: { tool: "appstrate_gmail__list", arguments: {} },
          output: mcp({ ok: true }, gmailTool("List")),
        }),
        // Persisted before the platform stamped presentations: no integration is guessed.
        call("i3", "call_integration_tool", {
          state: "output-available",
          input: { tool: "unlisted__tool", arguments: {} },
          output: mcp({ ok: true }),
        }),
      ]),
    ]);
    expect(calls.map((c) => c.integration?.id)).toEqual([
      "@appstrate/gmail",
      "@appstrate/gmail",
      undefined,
    ]);
    expect(integrations).toEqual([{ integration: GMAIL, calls: 2 }]);
  });

  it("counts a call as a lookup only by the engine's stamp", () => {
    const { calls } = conversationTools([
      assistant("a1", [
        call("l1", "search", {
          state: "output-available",
          input: { query: "x" },
          output: mcp({ results: [] }),
          callProviderMetadata: { appstrate: { lookup: true } },
        }),
        call("l2", "invoke_operation", {
          state: "output-available",
          input: { operation_id: "listRuns" },
          output: mcp({ status: 200 }),
        }),
      ]),
    ]);
    expect(calls.map((c) => c.lookup)).toEqual([true, false]);
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

describe("showCall", () => {
  it("names a call by its own tool and arguments until a presentation lands", () => {
    expect(
      showCall({ toolName: "invoke_operation", args: { operation_id: "deleteAgent" } }, t),
    ).toMatchObject({ label: "tool.op.other", idText: "deleteAgent" });
    expect(
      showCall({ toolName: "run_and_wait", args: { scope: "@acme", name: "triage" } }, t),
    ).toMatchObject({ label: "tool.name.run_and_wait|run_and_wait", idText: "@acme/triage" });
    // The tool's own name: the namespace (never holding `__`) is a lossy cut of the package id.
    expect(
      showCall(
        { toolName: "call_integration_tool", args: { tool: "acme_crm__find__by_email" } },
        t,
      ),
    ).toMatchObject({ idText: "find__by_email" });
    expect(
      showCall({ toolName: "call_integration_tool", args: { tool: "find" } }, t),
    ).toMatchObject({
      idText: "find",
    });
    expect(showCall({ toolName: "get_me", args: {} }, t)).toMatchObject({
      label: "tool.name.get_me|get_me",
    });
  });

  it("draws an integration call under its integration, the label naming the tool", () => {
    const shown = showCall(
      {
        toolName: "call_integration_tool",
        args: { tool: "appstrate_gmail__send" },
        result: mcp({ ok: true }, gmailTool("Send")),
      },
      t,
    );
    expect(shown).toMatchObject({ label: "Gmail · Send", subject: GMAIL });
    expect(shown.idText).toBeUndefined();
  });

  it("draws an operation by its method and tag", () => {
    const shown = showCall(
      {
        toolName: "invoke_operation",
        args: { operation_id: "deleteAgent" },
        result: mcp(
          { status: 204 },
          {
            title: "Delete agent",
            method: "DELETE",
            tag: "Agents",
          },
        ),
      },
      t,
    );
    expect(shown.label).toBe("tool.verb.DELETE|DELETE · tool.tag.Agents|Agents");
    // The operation's id, never its English summary.
    expect(shown.idText).toBe("deleteAgent");
  });

  it("ignores a presentation the schema refuses", () => {
    expect(
      showCall({ toolName: "get_me", args: {}, result: mcp({}, { title: 42 }) }, t),
    ).toMatchObject({ label: "tool.name.get_me|get_me" });
  });
});
