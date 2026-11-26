// SPDX-License-Identifier: Apache-2.0

/**
 * A `call_integration_tool` call's outcome, from the platform's MCP result to the context panel:
 * whether it failed is the server's `isError`, and whether its integration was used is declared
 * (a relayed result, or an upstream response in an `api_call` batch), never guessed off a payload.
 *
 * The platform MCP server is an in-process stub answering the result shapes the platform builds
 * (`apps/api/src/modules/mcp`: `jsonResult`, `refusalResult`, `withPresentation`, the relayed
 * mark). The tool is the chat's own (`buildPlatformMcpTools`), executed as Pi executes it. Pi's
 * `tool_execution_end` carries the result as returned and `isError: result.isError === true`
 * (`executePreparedToolCall`, `@earendil-works/pi-agent-core` 1.5.2): that event goes through the
 * real `PiChatUiStreamMapper`, folded by the AI SDK's `readUIMessageStream`.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { TOOL_PRESENTATION_META_KEY } from "@appstrate/core/mcp-presentation";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";
import { conversationTools } from "../src/ui/conversation-tools.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const GMAIL = { kind: "integration", id: "@appstrate/gmail", display_name: "Gmail" } as const;
const GITHUB = { kind: "integration", id: "@acme/github", display_name: "GitHub" } as const;

const API_CALL = { tool: "appstrate_gmail__api_call", arguments: { requests: [{}, {}] } };

/** `jsonResult` (`tool-results.ts`): the payload as text and as `structuredContent`. */
function jsonResult(payload: Record<string, unknown>, isError: boolean) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError,
    structuredContent: isError
      ? { ...payload, kind: typeof payload.status === "number" ? "route_refusal" : "tool_refusal" }
      : payload,
  };
}

/** `withPresentation` (`presentation.ts`): the call's presentation on the result's `_meta`. */
function presented(result: Record<string, unknown>, presentation: Record<string, unknown>) {
  const meta = (result._meta as Record<string, unknown> | undefined) ?? {};
  return { ...result, _meta: { ...meta, [TOOL_PRESENTATION_META_KEY]: presentation } };
}

/** `markRelayedResult` (`@appstrate/mcp-transport`): a remote server's answer, relayed. */
function relayed(result: Record<string, unknown>) {
  const meta = (result._meta as Record<string, unknown> | undefined) ?? {};
  return { ...result, _meta: { ...meta, "dev.appstrate/relayed": true } };
}

/** What the platform answers each call, by the `tool` it names. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  // Every request refused before it was sent: `failed === results.length`.
  refused_batch: presented(
    jsonResult(
      {
        session_id: "cps_1",
        results: [
          {
            index: 0,
            error: { code: "not_sent", detail: "Not sent: the batch reached its deadline first." },
          },
          {
            index: 1,
            error: { code: "not_sent", detail: "Not sent: the batch reached its deadline first." },
          },
        ],
      },
      true,
    ),
    { title: "API call", subject: GMAIL },
  ),
  // One request answered, one refused: not an error.
  partial_batch: presented(
    jsonResult(
      {
        session_id: "cps_2",
        results: [
          { index: 0, status: 200, headers: {}, body: { messages: [] } },
          { index: 1, error: { code: "not_sent", detail: "Not sent." } },
        ],
      },
      false,
    ),
    { title: "API call", subject: GMAIL },
  ),
  // A remote tool's 401, relayed as its server answered it.
  relayed_401: presented(
    relayed({ content: [{ type: "text", text: "401 Bad credentials" }], isError: true }),
    { title: "Create issue", subject: GITHUB },
  ),
  // The integration has no usable connection here: refused before any exchange.
  missing_connection: presented(
    jsonResult(
      {
        integration_package_id: "@appstrate/gmail",
        refusal: {
          status: 409,
          title: "Conflict",
          detail: "Gmail is not connected in this space.",
        },
      },
      true,
    ),
    { title: "API call", subject: GMAIL },
  ),
};

/** A distinct URL per use: the MCP surface is cached by it. */
const mcpUrl = () => `http://127.0.0.1:1/api/mcp/o/org_outcome_${crypto.randomUUID()}`;

const mcpFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = new Request(input, init);
  if (req.method === "GET") return new Response(null, { status: 405 });
  if (req.method === "DELETE") return new Response(null, { status: 202 });
  const msg = (await req.json()) as {
    id?: unknown;
    method?: string;
    params?: { arguments?: { tool?: string } };
  };
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const result =
    msg.method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
        }
      : msg.method === "tools/list"
        ? { tools: [{ name: "call_integration_tool", inputSchema: { type: "object" } }] }
        : msg.method === "tools/call"
          ? ANSWERS[msg.params?.arguments?.tool ?? ""]
          : {};
  const headers = msg.method === "initialize" ? { "mcp-session-id": "sess_outcome" } : undefined;
  return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers });
}) as typeof fetch;

interface ExecutedTool {
  name: string;
  execute: (id: string, params: unknown) => Promise<Record<string, unknown>>;
}

/** Each named call executed by the chat's own tool, then reported as Pi reports it. */
async function turn(calls: { id: string; answer: string; args?: Record<string, unknown> }[]) {
  const built = await buildPlatformMcpTools({
    url: mcpUrl(),
    headers: {},
    organization: inertTurnSpaces(),
    fetch: mcpFetch,
    writeChunk: () => {},
    fileDelivery: { image: false, pdf: false },
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
  });
  const tools: ExecutedTool[] = [];
  const pi = { registerTool: (tool: ExecutedTool) => tools.push(tool) } as unknown as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  const tool = tools.find((t) => t.name === "call_integration_tool")!;

  const events: AgentSessionEvent[] = [{ type: "message_start", message: { role: "assistant" } }];
  const results: Record<string, Record<string, unknown>> = {};
  try {
    for (const [index, call] of calls.entries()) {
      const args = { ...(call.args ?? API_CALL), tool: call.answer };
      const result = await tool.execute(call.id, args);
      results[call.id] = result;
      events.push(
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: index,
            partial: {
              content: Object.assign([], {
                [index]: { type: "toolCall", id: call.id, name: "call_integration_tool" },
              }),
            },
          },
        } as AgentSessionEvent,
        {
          type: "message_update",
          message: {},
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: index,
            toolCall: { id: call.id, name: "call_integration_tool", arguments: args },
            partial: {},
          },
        } as AgentSessionEvent,
        {
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: "call_integration_tool",
          result,
          isError: result.isError === true,
          durationMs: 40 + index,
        } as AgentSessionEvent,
      );
    }
  } finally {
    await built.close();
  }
  events.push({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });

  const mapper = new PiChatUiStreamMapper();
  const chunks: UIMessageChunk[] = [
    mapper.startChunk("a1"),
    ...events.flatMap((event) => mapper.map(event)),
    { type: "finish" },
  ];
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let message: UIMessage | undefined;
  for await (const m of readUIMessageStream({ stream })) message = m;
  return { results, tools: conversationTools([message!]) };
}

describe("a call_integration_tool call's outcome", () => {
  it("keeps the server's isError and presentation on the Pi result, relayed or not", async () => {
    const { results } = await turn([
      { id: "r", answer: "relayed_401" },
      { id: "b", answer: "refused_batch" },
      { id: "p", answer: "partial_batch" },
    ]);
    expect(results.r).toMatchObject({
      isError: true,
      relayed: true,
      answered: true,
      presentation: { title: "Create issue", subject: GITHUB },
    });
    expect(results.b).toMatchObject({ isError: true, presentation: { subject: GMAIL } });
    expect(results.b).not.toHaveProperty("answered");
    expect(results.p).not.toHaveProperty("isError");
    expect(results.p).toMatchObject({ answered: true });
  });

  it("is failed exactly when the server says so, and used only when the integration answered", async () => {
    const { tools } = await turn([
      { id: "b", answer: "refused_batch" },
      { id: "p", answer: "partial_batch" },
      { id: "r", answer: "relayed_401" },
      { id: "m", answer: "missing_connection" },
    ]);
    const byId = Object.fromEntries(tools.calls.map((c) => [c.toolCallId, c]));
    expect(byId.b).toMatchObject({
      status: "error",
      error: "Not sent: the batch reached its deadline first.",
      presentation: { subject: GMAIL },
      durationMs: 40,
    });
    expect(byId.p).toMatchObject({ status: "success", durationMs: 41 });
    expect(byId.r).toMatchObject({
      status: "error",
      error: "401 Bad credentials",
      presentation: { subject: GITHUB },
    });
    expect(byId.m).toMatchObject({
      status: "error",
      error: "Gmail is not connected in this space.",
    });
    // The partial batch reached Gmail, the relayed 401 reached GitHub; the two refusals did not.
    expect(tools.integrations).toEqual([GMAIL, GITHUB]);
  });

  it("counts no integration for a turn of refusals", async () => {
    const { tools } = await turn([
      { id: "b", answer: "refused_batch" },
      { id: "m", answer: "missing_connection" },
    ]);
    expect(tools.calls.map((c) => c.status)).toEqual(["error", "error"]);
    expect(tools.integrations).toEqual([]);
  });
});
