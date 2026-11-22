// SPDX-License-Identifier: Apache-2.0

import { AGENT_PROMPT_PART_TYPE, agentPromptOfParts } from "../agent-prompt.ts";
import { AGENT_DIRECTIVE, serializeDirective } from "../directives.ts";

interface AgentChip {
  name: string;
  title: string;
}

/** A retry's content: its request led by the directive of the agent the failed turn launched. */
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
  const parts = partsOf(message).map((part) =>
    isAgentPromptPart(part) ? { ...part, type: AGENT_PROMPT_PART_TYPE } : part,
  );
  const launch = agentPromptOfParts(parts);
  return launch && { name: launch.data.name, title: launch.data.title };
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
