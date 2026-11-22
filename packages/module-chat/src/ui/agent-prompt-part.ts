// SPDX-License-Identifier: Apache-2.0

/**
 * An agent launch carried by a user message: how a message's agent prompt part is read back (live
 * or replayed from history). The send writes the part from the message's agent directive
 * (`directive-send.ts`).
 */

import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "../agent-prompt.ts";
import { AGENT_DIRECTIVE, serializeDirective } from "../directives.ts";

/** What the browser sends of an agent prompt (the server adds the launch text). */
export interface AgentChip {
  name: string;
  title: string;
}

/**
 * The content of a retry: its request, led by the directive of the agent the failed turn launched
 * (the retry asks the model to check the state first, so the launch is named again, not silently
 * repeated). The send turns the directive into the agent prompt part, as for any message.
 */
export function retryContent(text: string, agent: AgentChip | null) {
  const named = agent
    ? serializeDirective({ type: AGENT_DIRECTIVE, label: agent.title, id: agent.name })
    : null;
  return [{ type: "text" as const, text: named ? `${named} ${text}` : text }];
}

/** The runtime's name for the agent prompt part (`data-` is what the wire part type adds). */
const AGENT_PROMPT_NAME = AGENT_PROMPT_PART_TYPE.slice("data-".length);

interface MessageLike {
  content?: unknown;
  parts?: unknown;
}

interface PartLike {
  type?: unknown;
  name?: unknown;
  data?: unknown;
}

/** The runtime's thread message holds `{ type: "data", name }`, a stored one `{ type: "data-…" }`. */
function isAgentPromptPart(part: PartLike | null | undefined): boolean {
  return (
    part?.type === AGENT_PROMPT_PART_TYPE ||
    (part?.type === "data" && part.name === AGENT_PROMPT_NAME)
  );
}

function partsOf(message: MessageLike): readonly PartLike[] {
  const parts = message.content ?? message.parts;
  return Array.isArray(parts) ? (parts as PartLike[]) : [];
}

/** The agent a user message launches, `null` when it launches none. Never the launch text. */
export function agentPromptOf(message: MessageLike): AgentChip | null {
  for (const part of partsOf(message)) {
    if (!isAgentPromptPart(part)) continue;
    const parsed = agentPromptDataSchema.safeParse(part.data);
    return parsed.success ? { name: parsed.data.name, title: parsed.data.title } : null;
  }
  return null;
}

/** The user message the turn `messageId` answers: the nearest one before it. */
export function precedingUserMessage<M extends { id: string; role: string }>(
  messages: readonly M[],
  messageId: string,
): M | undefined {
  const at = messages.findIndex((message) => message.id === messageId);
  for (let i = (at === -1 ? 0 : at) - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i];
  }
  return undefined;
}

/** Whether the message holds anything but its agent prompt: the bubble is drawn for that alone. */
export function hasBubbleContent(message: MessageLike): boolean {
  return partsOf(message).some((part) => !isAgentPromptPart(part));
}
