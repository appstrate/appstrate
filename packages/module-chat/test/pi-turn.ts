// SPDX-License-Identifier: Apache-2.0

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { PiChatUiStreamMapper } from "../src/pi-chat/ui-stream-mapper.ts";
import type { AgentSessionEvent } from "../src/pi-chat/pi-events.ts";

/** The model's call `id` of `name`, block `index` of its message, as Pi streams it. */
export function toolCallEvents(
  index: number,
  id: string,
  name: string,
  args: Record<string, unknown>,
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
    },
    {
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: index,
        toolCall: { id, name, arguments: args },
        partial: {},
      },
    },
  ];
}

/** One assistant message's events through the chat's mapper, folded as the AI SDK stores it. */
export async function streamedMessage(
  events: AgentSessionEvent[],
  mapper = new PiChatUiStreamMapper(),
): Promise<UIMessage> {
  const chunks: UIMessageChunk[] = [
    mapper.startChunk("a1"),
    ...[
      { type: "message_start", message: { role: "assistant" } },
      ...events,
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ].flatMap((event) => mapper.map(event)),
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

/**
 * A stateless platform MCP server listing `tools` and answering `tools/call` with `call`; its URL
 * is distinct per use, as the chat caches a surface by URL.
 */
export function stubPlatformMcp(
  tools: unknown[],
  call: (params: { name?: string; arguments?: Record<string, unknown> }) => unknown = () => ({}),
): { url: string; fetch: typeof fetch } {
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 202 });
    const msg = (await req.json()) as { id?: unknown; method?: string; params?: never };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result =
      msg.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-platform-mcp", version: "1.0.0" },
          }
        : msg.method === "tools/list"
          ? { tools }
          : msg.method === "tools/call"
            ? call(msg.params ?? {})
            : {};
    const headers = msg.method === "initialize" ? { "mcp-session-id": "sess_stub" } : undefined;
    return Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers });
  };
  return {
    url: `http://127.0.0.1:1/api/mcp/o/org_stub_${crypto.randomUUID()}`,
    fetch: fetchStub as typeof fetch,
  };
}
