// SPDX-License-Identifier: Apache-2.0

// A composer agent launch (`agent-prompt.ts`), resolved into its instructions by `prompts/get`.

import type { UIMessage } from "ai";
import {
  ErrorCode,
  McpError,
  jsonRpcErrorOf,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { invalidRequest } from "@appstrate/core/api-errors";
import { agentPromptOfParts } from "./agent-prompt.ts";
import { uiMessageText } from "./message-text.ts";
import { withCallerClient } from "./platform-mcp.ts";

const AGENT_LAUNCH_MAX_BYTES = 64 * 1024;

/**
 * `message` with its agent-prompt part's `text` set to what `prompts/get` answers for its name and
 * the typed request, whatever the browser sent (no part, no connection). An unknown or
 * unlaunchable name, or instructions over {@link AGENT_LAUNCH_MAX_BYTES}, is a 400. The cap counts
 * the instructions as rendered, the agent's text with the user's request in it, so its message
 * names both.
 */
export async function resolveAgentPrompt(
  message: UIMessage,
  openCaller: (signal: AbortSignal) => Promise<AppstrateMcpClient>,
): Promise<UIMessage> {
  const launch = agentPromptOfParts(message.parts);
  if (!launch) return message;
  const { part } = launch;
  const { name, title } = launch.data;
  const text = await withCallerClient(openCaller, async (client, signal) => {
    const request = uiMessageText(message.parts, { omitAgent: true });
    try {
      const result = await client.getPrompt({ name, arguments: { request } }, { signal });
      return result.messages
        .flatMap((entry) => (entry.content.type === "text" ? [entry.content.text] : []))
        .join("\n\n");
    } catch (err) {
      // The server answers one `-32602` for a name it does not serve and for one it cannot launch
      // (a `ProtocolError` over HTTP, an `McpError` over an in-process pair).
      const code = jsonRpcErrorOf(err)?.code ?? (err instanceof McpError ? err.code : undefined);
      if (code === ErrorCode.InvalidParams) {
        throw invalidRequest(`"${name}" is not an agent this conversation can launch.`, "messages");
      }
      throw err;
    }
  });
  if (Buffer.byteLength(text) > AGENT_LAUNCH_MAX_BYTES) {
    throw invalidRequest(
      `The launch instructions of "${name}" exceed ${AGENT_LAUNCH_MAX_BYTES / 1024} KB. They include your request: a shorter one may fit.`,
      "messages",
    );
  }
  if (text === "")
    throw invalidRequest(`The agent "${name}" gave no launch instructions.`, "messages");
  return {
    ...message,
    parts: message.parts.map((candidate) =>
      candidate === part ? { ...part, data: { name, title, text } } : candidate,
    ),
  } as UIMessage;
}

/**
 * The thread with every earlier launch's text taken from its stored row (`stored`, by message id),
 * never from the browser; the last one's comes from {@link resolveAgentPrompt}. A launch with no
 * stored text shows the model what the user typed.
 */
export function withStoredAgentPromptTexts(
  messages: UIMessage[],
  stored: ReadonlyMap<string, string>,
): UIMessage[] {
  return messages.map((message, index) => {
    const launch = message.role === "user" ? agentPromptOfParts(message.parts) : null;
    if (!launch) return message;
    const { name, title } = launch.data;
    const text = index === messages.length - 1 ? undefined : stored.get(message.id);
    return {
      ...message,
      parts: message.parts.map((part) =>
        part === launch.part ? { ...part, data: { name, title, ...(text ? { text } : {}) } } : part,
      ),
    } as UIMessage;
  });
}
