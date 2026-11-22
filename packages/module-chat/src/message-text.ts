// SPDX-License-Identifier: Apache-2.0

import type { UIMessage } from "ai";
import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "./agent-prompt.ts";
import { readableDirectives } from "./directives.ts";

/**
 * Concatenate the text of a UIMessage's `text` parts (all other part kinds —
 * tool calls, files — dropped), trimmed, with the skills and agents the user named read as
 * `/label` (`readableDirectives`). Accepts the raw `parts` array so it works on both a typed
 * `UIMessage` (transcript building) and a narrowed JSONB `content.parts` read from storage
 * (title derivation). `omitAgent` drops the agent directive: the request an agent launch is
 * resolved with does not name the agent it launches.
 */
export function uiMessageText(parts: unknown[] | undefined, options?: { omitAgent?: boolean }) {
  return readableDirectives(
    (parts ?? [])
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? ((p as { text?: string }).text ?? "")
          : "",
      )
      .join(""),
    options,
  ).trim();
}

/**
 * The message as the model reads it: a message carrying a resolved agent launch
 * (`agent-prompt.ts`) shows its `text`, the launch instructions, in place of what the user typed,
 * which they already embed as their request. Any other user message shows its text with the
 * directives read as `/label`, never as the composer's `:skill[…]{…}` syntax. The one place a
 * user turn becomes model text, on the turn itself and on every replay.
 */
export function withModelText(message: UIMessage): UIMessage {
  if (message.role !== "user") return message;
  const launch = message.parts.find((part) => part.type === AGENT_PROMPT_PART_TYPE);
  const data = agentPromptDataSchema.safeParse((launch as { data?: unknown } | undefined)?.data);
  if (!launch || !data.success || data.data.text === undefined) return withReadableText(message);
  const text = { type: "text" as const, text: data.data.text };
  return {
    ...message,
    parts: message.parts.flatMap((part): UIMessage["parts"] =>
      part === launch ? [text] : part.type === "text" ? [] : [part],
    ),
  };
}

function withReadableText(message: UIMessage): UIMessage {
  let changed = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "text") return part;
    const text = readableDirectives(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...message, parts } : message;
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
