// SPDX-License-Identifier: Apache-2.0

/**
 * One turn's tool calls, from the engine's chunks to what the thread and the context panel show.
 *
 * The chunks are the real `PiChatUiStreamMapper`'s, folded into a message by the AI SDK's own
 * `readUIMessageStream` (the client's `useChat` and the server's persistence run the same
 * processing). The panel reads that message (`conversationTools`). The thread reads the
 * assistant-ui part `@assistant-ui/ai-sdk` converts it to: that converter is not exported, so
 * {@link threadPart} restates the fields the grouping and the cards read (`convertMessage.ts`),
 * and the card reaches the stored part through the message binding assistant-ui keeps
 * (`bindExternalStoreMessage`, `getExternalStoreMessages`).
 */

import { describe, expect, it } from "bun:test";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { bindExternalStoreMessage, type ThreadMessage } from "@assistant-ui/react";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import { TOOL_PRESENTATION_META_KEY } from "@appstrate/core/mcp-presentation";
import { buildPlatformMcpTools } from "../src/pi-chat/mcp-tools.ts";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";
import { activityGroupOf, conversationTools } from "../src/ui/conversation-tools.ts";
import { callPresentation, showCall } from "../src/ui/tool-presentation.ts";
import { resultMetadataOf } from "../src/ui/use-call-presentation.ts";
import { streamedMessage, stubPlatformMcp, toolCallEvents } from "./pi-turn.ts";
import { inertTurnSpaces } from "./turn-spaces.ts";

const GMAIL = { kind: "integration", id: "@appstrate/gmail", display_name: "Gmail" } as const;
const GITHUB = { kind: "integration", id: "@acme/github", display_name: "GitHub" } as const;

const t = (key: string, params?: Record<string, string | number>) =>
  ({ "tool.verb.GET": "Lecture" })[key] ?? String(params?.defaultValue ?? key);

/** A call the model makes and the tool's outcome, as Pi reports them. */
function call(
  index: number,
  id: string,
  name: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  isError = false,
  durationMs?: number,
): AgentSessionEvent[] {
  return [
    ...toolCallEvents(index, id, name, args),
    {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      result,
      isError,
      ...(durationMs !== undefined && { durationMs }),
    },
  ];
}

const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];

/**
 * The turn: two lookups (one fails), a relayed failure of GitHub, a Gmail read. The results are
 * the Pi results the chat's tool returns (`pi-chat/mcp-tools.ts`).
 */
const EVENTS: AgentSessionEvent[] = [
  ...call(
    0,
    "s1",
    "search",
    { query: "issues" },
    {
      content: text({ results: [] }),
      details: {},
      presentation: { count: 1, items: [GITHUB] },
    },
  ),
  ...call(
    1,
    "s2",
    "search",
    { query: "x" },
    { content: text({ status: 500, error: "down" }), details: {} },
  ),
  ...call(
    2,
    "g1",
    "call_integration_tool",
    { tool: "acme_github__create_issue", arguments: { title: "Bug" } },
    {
      content: [{ type: "text", text: "403 Resource not accessible" }],
      details: {},
      relayed: true,
      presentation: { title: "Create issue", subject: GITHUB },
    },
    true,
    12,
  ),
  ...call(
    3,
    "m1",
    "call_integration_tool",
    { tool: "appstrate_gmail__api_call", arguments: { method: "GET", path: "/messages" } },
    {
      content: text({ results: [{ index: 0, status: 200 }] }),
      details: {},
      presentation: { method: "GET", subject: GMAIL },
    },
  ),
];

function streamedTurn(): Promise<UIMessage> {
  const mapper = new PiChatUiStreamMapper();
  mapper.describeLookupTools(new Set(["search"]));
  return streamedMessage(EVENTS, mapper);
}

/** The assistant-ui `tool-call` part of a stored part, as `convertMessage.ts` builds it. */
function threadPart(part: Extract<UIMessage["parts"][number], { toolCallId: string }>) {
  return {
    type: "tool-call",
    toolName: getToolName(part),
    toolCallId: part.toolCallId,
    status: { type: "complete" },
    result:
      part.state === "output-available"
        ? part.output
        : part.state === "output-error"
          ? { error: part.errorText }
          : undefined,
    isError: part.state === "output-error" || part.state === "output-denied",
    ...(part.callProviderMetadata ? { providerMetadata: part.callProviderMetadata } : {}),
  };
}

describe("a turn's tool calls, from the engine's chunks", () => {
  it("is folded by the thread off the stamp, counted by the panel off the stamp and presentation", async () => {
    const message = await streamedTurn();
    const parts = message.parts.filter(isToolUIPart);
    expect(parts.map((part) => part.toolCallId)).toEqual(["s1", "s2", "g1", "m1"]);

    const folded = parts.map((part) => activityGroupOf(threadPart(part)) !== null);
    const lookups = conversationTools([message]).calls.map((c) => c.lookup);
    // Both stamped searches fold, the failed one included; the failed write does not, nor the
    // Gmail GET, whose method lands with its result: its card stays where it was drawn.
    expect(folded).toEqual([true, true, false, false]);
    // The panel counts the GET a lookup.
    expect(lookups).toEqual([true, false, false, true]);
  });

  it("brings the presentation of a success and of a failure to the panel and the card", async () => {
    const message = await streamedTurn();
    const { calls } = conversationTools([message]);
    const labels = calls.map(
      (c) =>
        showCall({ toolName: c.toolName, args: c.input, presentation: c.presentation }, t).label,
    );
    expect(labels.slice(2)).toEqual(["GitHub · Create issue", "Gmail · Lecture"]);
    expect(calls[2]).toMatchObject({
      status: "error",
      error: "403 Resource not accessible",
      durationMs: 12,
    });
    expect(calls[3]).not.toHaveProperty("durationMs");

    // The card: the assistant-ui message is bound to the AI SDK one it was converted from.
    // Only its binding is read: the rest of the message is not the test's.
    const threadMessage = {
      id: message.id,
      role: "assistant",
      content: [],
    } as unknown as ThreadMessage;
    bindExternalStoreMessage(threadMessage, message);
    const stored = resultMetadataOf(threadMessage);
    const card = (id: string) => callPresentation({ resultProviderMetadata: stored.get(id) });
    for (const c of calls) expect(card(c.toolCallId)).toEqual(c.presentation);
    // The failed GitHub call keeps its integration on the card as in the panel.
    expect(card("g1")?.subject).toEqual(GITHUB);
  });
});

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

/** `withPresentation` (`presentation.ts`), and the relayed mark of a remote server's answer. */
function presented(
  result: Record<string, unknown>,
  presentation: Record<string, unknown>,
  relayed = false,
) {
  return {
    ...result,
    _meta: {
      [TOOL_PRESENTATION_META_KEY]: presentation,
      ...(relayed && { "dev.appstrate/relayed": true }),
    },
  };
}

const NOT_SENT = { code: "not_sent", detail: "Not sent: the batch reached its deadline first." };

/**
 * What the platform answers a `call_integration_tool` call (the shapes `apps/api/src/modules/mcp`
 * builds), the Pi result the chat's tool makes of it, and the call the panel shows.
 */
const OUTCOMES: Record<
  string,
  {
    answer: Record<string, unknown>;
    failed: boolean;
    result: Record<string, unknown>;
    shown: Record<string, unknown>;
  }
> = {
  // Every request refused before it was sent.
  refused_batch: {
    answer: presented(
      jsonResult(
        {
          session_id: "cps_1",
          results: [
            { index: 0, error: NOT_SENT },
            { index: 1, error: NOT_SENT },
          ],
        },
        true,
      ),
      { subject: GMAIL },
    ),
    failed: true,
    result: { presentation: { subject: GMAIL } },
    shown: { status: "error", error: NOT_SENT.detail, presentation: { subject: GMAIL } },
  },
  // One request answered, one refused: not an error.
  partial_batch: {
    answer: presented(
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
      { subject: GMAIL },
    ),
    failed: false,
    result: {},
    shown: { status: "success" },
  },
  // A remote tool's 401, relayed as its server answered it.
  relayed_401: {
    answer: presented(
      { content: [{ type: "text", text: "401 Bad credentials" }], isError: true },
      { title: "Create issue", subject: GITHUB },
      true,
    ),
    failed: true,
    result: { relayed: true, presentation: { title: "Create issue", subject: GITHUB } },
    shown: { status: "error", error: "401 Bad credentials", presentation: { subject: GITHUB } },
  },
  // The integration has no usable connection here: refused before any exchange.
  missing_connection: {
    answer: presented(
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
      { subject: GMAIL },
    ),
    failed: true,
    result: {},
    shown: { status: "error", error: "Gmail is not connected in this space." },
  },
};

describe("a call_integration_tool call's outcome", () => {
  it("is failed exactly when the server says so, with its presentation, relayed or not", async () => {
    const mcp = stubPlatformMcp(
      [{ name: "call_integration_tool", inputSchema: { type: "object" } }],
      (params) => OUTCOMES[String(params.arguments?.tool)]!.answer,
    );
    const built = await buildPlatformMcpTools({
      ...mcp,
      headers: {},
      organization: inertTurnSpaces(),
      writeChunk: () => {},
      fileDelivery: { image: false, pdf: false },
      signal: new AbortController().signal,
      turnBudget: { deadlineAt: Date.now() + 60_000, stepCount: () => 0 },
    });
    type Executed = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };
    const registered: Executed[] = [];
    const pi = {
      registerTool: (tool: Executed) => registered.push(tool),
    } as unknown as ExtensionAPI;
    for (const factory of built.extensionFactories) factory(pi);
    const tool = registered.find((candidate) => candidate.name === "call_integration_tool")!;

    // Each call executed by the chat's own tool, then reported as Pi reports it.
    const events: AgentSessionEvent[] = [];
    try {
      for (const [index, [name, outcome]] of Object.entries(OUTCOMES).entries()) {
        const args = { tool: name, arguments: { requests: [{}, {}] } };
        const result = (await tool.execute(name, args)) as Record<string, unknown>;
        expect(result).toMatchObject(outcome.result);
        expect(result.isError).toBe(outcome.failed || undefined);
        events.push(...call(index, name, "call_integration_tool", args, result, outcome.failed));
      }
    } finally {
      await built.close();
    }
    const { calls } = conversationTools([await streamedMessage(events)]);
    for (const [name, outcome] of Object.entries(OUTCOMES)) {
      expect(calls.find((c) => c.toolCallId === name)).toMatchObject(outcome.shown);
    }
  });
});
