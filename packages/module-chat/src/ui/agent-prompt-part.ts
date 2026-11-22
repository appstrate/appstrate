// SPDX-License-Identifier: Apache-2.0

/**
 * An agent launch chosen in the composer and shown in the thread: how it rides on the send, and how
 * a message's parts are read back (live or replayed from history).
 */

import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "../agent-prompt.ts";

/** What the browser sends of an agent prompt (the server adds the launch text). */
export interface AgentChip {
  name: string;
  title: string;
}

/**
 * The composer's run config while an agent is chosen. The runtime hands the config of a send to
 * the chat's `sendMessage` as request metadata (`agentOfRunConfig` reads it there), so the choice
 * belongs to that send alone: a message queued behind a running turn does not carry it.
 */
export function agentRunConfig(agent: AgentChip | null): { custom?: Record<string, unknown> } {
  return agent ? { custom: { agentPrompt: agent } } : {};
}

export function agentOfRunConfig(config: unknown): AgentChip | null {
  const stored = (config as { custom?: { agentPrompt?: unknown } } | null | undefined)?.custom
    ?.agentPrompt;
  const parsed = agentPromptDataSchema.safeParse(stored);
  return parsed.success ? { name: parsed.data.name, title: parsed.data.title } : null;
}

/**
 * The message a send hands the chat: when its run config chose an agent, the agent prompt part
 * joins the composer's parts (text, files), so the optimistic bubble shows it at once.
 */
export function messageWithAgentPrompt<M>(message: M, metadata: unknown): M {
  const agent = agentOfRunConfig(metadata);
  const parts = (message as { parts?: unknown } | undefined)?.parts;
  if (!agent || !Array.isArray(parts)) return message;
  return {
    ...(message as object),
    parts: [
      ...parts,
      { type: AGENT_PROMPT_PART_TYPE, data: { name: agent.name, title: agent.title } },
    ],
  } as M;
}

/**
 * The content of a retry: its request, and the agent the failed turn launched (the retry asks the
 * model to check the state first, so the launch is named again, not silently repeated).
 */
export function retryContent(text: string, agent: AgentChip | null) {
  return [{ type: "text" as const, text }, ...(agent ? agentOnlyContent(agent) : [])];
}

/** The runtime's name for the agent prompt part (`data-` is what the wire part type adds). */
export const AGENT_PROMPT_NAME = AGENT_PROMPT_PART_TYPE.slice("data-".length);

/**
 * The content of a message that is only an agent launch: the composer cannot send an empty draft,
 * so this goes through the thread, as a native data part.
 */
export function agentOnlyContent(agent: AgentChip) {
  return [
    {
      type: "data" as const,
      name: AGENT_PROMPT_NAME,
      data: { name: agent.name, title: agent.title },
    },
  ];
}

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
  return messages.slice(0, at === -1 ? 0 : at).findLast((message) => message.role === "user");
}

/** Whether the message holds anything but its agent prompt: the bubble is drawn for that alone. */
export function hasBubbleContent(message: MessageLike): boolean {
  return partsOf(message).some((part) => !isAgentPromptPart(part));
}
