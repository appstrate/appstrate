// SPDX-License-Identifier: Apache-2.0

import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "@appstrate/core/chat-message";
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

interface PartLike {
  type: string;
  name?: unknown;
  data?: unknown;
}

interface MessageLike {
  content: readonly PartLike[];
}

// The SDK converts stored data-agent-prompt parts to this same shape on reload.
function isAgentPromptPart(part: PartLike): boolean {
  return part.type === "data" && part.name === AGENT_PROMPT_NAME;
}

export function agentPromptOf(message: MessageLike): AgentChip | null {
  const launch = agentPromptDataSchema.safeParse(message.content.find(isAgentPromptPart)?.data);
  return launch.success ? { name: launch.data.name, title: launch.data.title } : null;
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
  return message.content.some((part) => !isAgentPromptPart(part));
}
