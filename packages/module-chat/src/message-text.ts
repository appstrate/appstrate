// SPDX-License-Identifier: Apache-2.0

import type { UIMessage } from "ai";
import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "./agent-prompt.ts";

/**
 * Concatenate the text of a UIMessage's `text` parts (all other part kinds —
 * tool calls, files — dropped), trimmed. Accepts the raw `parts` array so it
 * works on both a typed `UIMessage` (transcript building) and a narrowed JSONB
 * `content.parts` read from storage (title derivation).
 */
export function uiMessageText(parts: unknown[] | undefined): string {
  return (parts ?? [])
    .map((p) =>
      p && typeof p === "object" && (p as { type?: string }).type === "text"
        ? ((p as { text?: string }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

/**
 * The message as the model reads it: a message carrying a resolved agent launch
 * (`agent-prompt.ts`) shows its `text`, the launch instructions, in place of what the user typed,
 * which they already embed as their request. Any other message is returned as it is. The one
 * place a user turn becomes model text, on the turn itself and on every replay.
 */
export function withAgentPromptText(message: UIMessage): UIMessage {
  if (message.role !== "user") return message;
  const launch = message.parts.find((part) => part.type === AGENT_PROMPT_PART_TYPE);
  const data = agentPromptDataSchema.safeParse((launch as { data?: unknown } | undefined)?.data);
  if (!launch || !data.success || data.data.text === undefined) return message;
  const text = { type: "text" as const, text: data.data.text };
  return {
    ...message,
    parts: message.parts.flatMap((part): UIMessage["parts"] =>
      part === launch ? [text] : part.type === "text" ? [] : [part],
    ),
  };
}

/**
 * The text a conversation is titled from: what the user typed, else the title of the agent launch
 * the message carries. The one reader behind both title derivations (`persistence.ts`).
 */
export function uiMessageTitleText(parts: unknown[] | undefined): string {
  const typed = uiMessageText(parts);
  if (typed) return typed;
  const launch = (parts ?? []).find(
    (part) => (part as { type?: unknown } | null)?.type === AGENT_PROMPT_PART_TYPE,
  );
  const data = agentPromptDataSchema.safeParse((launch as { data?: unknown } | undefined)?.data);
  return data.success ? data.data.title : "";
}
