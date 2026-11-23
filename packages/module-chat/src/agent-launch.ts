// SPDX-License-Identifier: Apache-2.0

// A composer agent launch (`agent-prompt.ts`), resolved into its instructions by `prompts/get`.

import type { UIMessage } from "ai";
import { ErrorCode, jsonRpcErrorOf, type AppstrateMcpClient } from "@appstrate/mcp-transport";
import { badGateway, invalidRequest } from "@appstrate/core/api-errors";
import { agentPromptOfParts } from "./agent-prompt.ts";
import { uiMessageText } from "./message-text.ts";
import { withCallerClient } from "./platform-mcp.ts";
import { logger } from "./logger.ts";

const AGENT_LAUNCH_MAX_BYTES = 64 * 1024;

/** Characters of earlier launch texts replayed on a later turn, most recent first; older ones become a stub. */
export const AGENT_LAUNCH_REPLAY_BUDGET_CHARS = 64_000;

/**
 * `message` with its agent-prompt part's `text` set to what `prompts/get` answers, whatever the
 * browser sent. An unknown or unlaunchable name, or instructions over
 * {@link AGENT_LAUNCH_MAX_BYTES} (counted as rendered, request included), is a 400; a platform
 * server that fails to answer is a 502.
 */
export async function resolveAgentPrompt(
  message: UIMessage,
  openCaller: (signal: AbortSignal) => Promise<AppstrateMcpClient>,
): Promise<UIMessage> {
  const launch = agentPromptOfParts(message.parts);
  if (!launch) return message;
  const { part } = launch;
  const { name, title } = launch.data;
  const text = await withCallerClient(
    openCaller,
    async (client, signal) => {
      const request = uiMessageText(message.parts, { omitAgent: true });
      try {
        const result = await client.getPrompt({ name, arguments: { request } }, { signal });
        return result.messages
          .flatMap((entry) => (entry.content.type === "text" ? [entry.content.text] : []))
          .join("\n\n");
      } catch (err) {
        // The server answers one `-32602` for a name it does not serve and for one it cannot launch.
        if (jsonRpcErrorOf(err)?.code === ErrorCode.InvalidParams) {
          throw invalidRequest(
            `"${name}" is not an agent this conversation can launch.`,
            "messages",
          );
        }
        // Any other failure (an internal error, a timeout, a malformed answer) is the server's.
        logger.warn("prompts/get failed — agent launch refused", { name, err: String(err) });
        throw badGateway("The platform's MCP server could not read the agent.");
      }
    },
    (err) => {
      logger.warn("agent launch connection unavailable", { name, err: String(err) });
      throw badGateway("The platform's MCP server could not be reached.");
    },
  );
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

/** What the model reads in place of a launch whose text fell out of the replay budget. */
function droppedLaunchText(name: string, title: string): string {
  return `[The agent "${title}" (${name}) was launched here earlier. Its launch instructions were dropped from this history to bound its size; launch it again if it is needed.]`;
}

/**
 * The thread with each earlier launch's text taken from its stored row (`stored`, by message id),
 * never from the browser, most recent first within {@link AGENT_LAUNCH_REPLAY_BUDGET_CHARS}; older
 * ones become a stub. Pure in the thread and the rows: the same thread replays the same prompt (a
 * new launch can push an older one out of the budget, which then reads as its stub).
 */
export function withStoredAgentPromptTexts(
  messages: UIMessage[],
  stored: ReadonlyMap<string, string>,
): UIMessage[] {
  let remaining = AGENT_LAUNCH_REPLAY_BUDGET_CHARS;
  const out = [...messages];
  // The last message is the new one: the schema already refuses a `text` on it.
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index]!;
    const launch = message.role === "user" ? agentPromptOfParts(message.parts) : null;
    if (!launch) continue;
    const { name, title } = launch.data;
    const full = stored.get(message.id);
    let text: string | undefined;
    if (full && full.length <= remaining) {
      remaining -= full.length;
      text = full;
    } else if (full) {
      // Once one launch does not fit, no older one is kept: the budget never skips back.
      remaining = 0;
      text = droppedLaunchText(name, title);
    }
    out[index] = {
      ...message,
      parts: message.parts.map((part) =>
        part === launch.part ? { ...part, data: { name, title, ...(text ? { text } : {}) } } : part,
      ),
    } as UIMessage;
  }
  return out;
}
