// SPDX-License-Identifier: Apache-2.0

/**
 * One turn's tool calls, from the engine's chunks to what the thread and the context panel show.
 *
 * The chunks are the real `PiChatUiStreamMapper`'s, folded into a message by the AI SDK's own
 * `readUIMessageStream` (the client's `useChat` and the server's persistence run the same
 * processing). The panel reads that message (`conversationTools`). The thread reads the
 * assistant-ui part `@assistant-ui/ai-sdk` converts it to: that converter is not exported, so
 * {@link threadPart} restates the two fields the grouping and the cards read, as
 * `@assistant-ui/ai-sdk@0.0.19` `src/converters/convertMessage.ts` (l. 559-571 and 660-664) sets
 * them, and the card reaches the stored part through the message binding assistant-ui keeps
 * (`bindExternalStoreMessage`, `getExternalStoreMessages`).
 */

import { describe, expect, it } from "bun:test";
import { getToolName, isToolUIPart, readUIMessageStream, type UIMessage } from "ai";
import type { UIMessageChunk } from "ai";
import { bindExternalStoreMessage, type ThreadMessage } from "@assistant-ui/react";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";
import { conversationTools } from "../src/ui/conversation-tools.ts";
import { activityGroupOf } from "../src/ui/activity-group.ts";
import { callPresentation, showCall } from "../src/ui/tool-presentation.ts";
import { sourceToolPart } from "../src/ui/use-call-presentation.ts";

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
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: index,
        partial: { content: Object.assign([], { [index]: { type: "toolCall", id, name } }) },
      },
    } as AgentSessionEvent,
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: index,
        toolCall: { id, name, arguments: args },
        partial: {},
      },
    } as AgentSessionEvent,
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
 * the Pi results the chat's tool returns (`pi-chat/mcp-tools.ts`), `answered` included.
 */
const EVENTS: AgentSessionEvent[] = [
  { type: "message_start", message: { role: "assistant" } },
  ...call(
    0,
    "s1",
    "search",
    { query: "issues" },
    {
      content: text({ results: [] }),
      details: {},
      presentation: { title: "Search", count: 1, items: [GITHUB] },
    },
  ),
  ...call(
    1,
    "s2",
    "search",
    { query: "x" },
    {
      content: text({ status: 500, error: "down" }),
      details: {},
      presentation: { title: "Search" },
    },
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
      answered: true,
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
      answered: true,
      presentation: { title: "API call", method: "GET", subject: GMAIL },
    },
  ),
  { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
];

/** The message the AI SDK folds the mapper's chunks into. */
async function streamedMessage(): Promise<UIMessage> {
  const mapper = new PiChatUiStreamMapper();
  mapper.describeLookupTools(new Set(["search"]));
  const chunks: UIMessageChunk[] = [
    mapper.startChunk("a1"),
    ...EVENTS.flatMap((event) => mapper.map(event)),
    { type: "finish" },
  ];
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  return last!;
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
  it("is folded by the thread and counted by the panel off the same stamp and presentation", async () => {
    const message = await streamedMessage();
    const parts = message.parts.filter(isToolUIPart);
    expect(parts.map((part) => part.toolCallId)).toEqual(["s1", "s2", "g1", "m1"]);

    // The thread reads the presentation off the stored part, as the card does.
    const folded = parts.map(
      (part) => activityGroupOf(threadPart(part), callPresentation(part)) !== null,
    );
    const lookups = conversationTools([message]).calls.map((c) => c.lookup);
    // The stamped search and the Gmail GET fold; the failed search and the failed write do not.
    expect(folded).toEqual([true, false, false, true]);
    expect(lookups).toEqual(folded);
  });

  it("brings the presentation of a success and of a failure to the panel and the card", async () => {
    const message = await streamedMessage();
    const { calls, integrations } = conversationTools([message]);
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
    expect(integrations).toEqual([GITHUB, GMAIL]);

    // The card: the assistant-ui message is bound to the AI SDK one it was converted from.
    // Only its binding is read: the rest of the message is not the test's.
    const threadMessage = {
      id: message.id,
      role: "assistant",
      content: [],
    } as unknown as ThreadMessage;
    bindExternalStoreMessage(threadMessage, message);
    for (const c of calls) {
      expect(callPresentation(sourceToolPart(threadMessage, c.toolCallId))).toEqual(c.presentation);
    }
    // The failed GitHub call keeps its integration on the card as in the panel.
    expect(callPresentation(sourceToolPart(threadMessage, "g1"))?.subject).toEqual(GITHUB);
  });

  it("stores no presentation, answer or duration in a call's output", async () => {
    const message = await streamedMessage();
    for (const part of message.parts.filter(isToolUIPart)) {
      const output = JSON.stringify(("output" in part ? part.output : undefined) ?? null);
      for (const key of ["presentation", "answered", "durationMs"]) {
        expect(output).not.toContain(key);
      }
    }
  });
});
