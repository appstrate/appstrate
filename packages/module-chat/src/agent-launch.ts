// SPDX-License-Identifier: Apache-2.0

/**
 * Resolving an agent launch of the composer (`agent-prompt.ts`): the platform MCP server's
 * `prompts/get` turns the named prompt and the user's request into the launch instructions the
 * model is shown for the message.
 */

import type { UIMessage } from "ai";
import {
  ErrorCode,
  McpError,
  jsonRpcErrorOf,
  type AppstrateMcpClient,
} from "@appstrate/mcp-transport";
import { invalidRequest } from "@appstrate/core/api-errors";
import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "./agent-prompt.ts";
import { uiMessageText } from "./message-text.ts";
import { CALLER_READ_TIMEOUT_MS } from "./prompt.ts";

/**
 * `message` with its agent-prompt part resolved: `data.text` is what `prompts/get` returns for
 * the part's name and the typed text as `request`, whatever the browser sent. A message without
 * the part is returned as it is, and no connection is opened. An unknown or unlaunchable name is
 * a 400; the connection is closed before returning.
 */
export async function resolveAgentPrompt(
  message: UIMessage,
  openCaller: (signal: AbortSignal) => Promise<AppstrateMcpClient>,
): Promise<UIMessage> {
  const part = message.parts.find((candidate) => candidate.type === AGENT_PROMPT_PART_TYPE);
  if (!part) return message;
  const { name, title } = agentPromptDataSchema.parse((part as { data?: unknown }).data);
  const signal = AbortSignal.timeout(CALLER_READ_TIMEOUT_MS);
  const client = await openCaller(signal);
  let text: string;
  try {
    const request = uiMessageText(message.parts);
    const result = await client.getPrompt({ name, arguments: { request } }, { signal });
    text = result.messages
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
  } finally {
    await client.close().catch(() => {});
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
