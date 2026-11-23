// SPDX-License-Identifier: Apache-2.0

// What a send does with the directives it keeps in its text: each skill is pinned, the agent
// becomes the agent prompt part. The server validates both; a directive carries no authority.

import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "../agent-prompt.ts";
import { AGENT_DIRECTIVE, directivesOf } from "../directives.ts";
import { citedSkillIds } from "./chat-skills.ts";

/**
 * Whether a draft names more than one agent, which it cannot send. Skills never refuse a draft: a
 * pin past the budget is reported `over_budget` by the turn.
 */
export function namesSeveralAgents(text: string): boolean {
  return directivesOf(text).filter((d) => d.type === AGENT_DIRECTIVE).length > 1;
}

/** Whether a text launches an agent. */
export function namesAgent(text: string): boolean {
  return directivesOf(text).some((d) => d.type === AGENT_DIRECTIVE);
}

/** The message with its first agent as the agent prompt part (unless replayed), and its skills. */
export function sendWithDirectives<M>(message: M): { message: M; skills: string[] } {
  const parts = (message as { parts?: unknown } | undefined)?.parts;
  if (!Array.isArray(parts)) return { message, skills: [] };
  const text = parts
    .flatMap((part: { type?: unknown; text?: unknown } | null) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
  const skills = citedSkillIds(text);
  const agent = directivesOf(text).find((d) => d.type === AGENT_DIRECTIVE);
  const launched = parts.some(
    (part: { type?: unknown } | null) => part?.type === AGENT_PROMPT_PART_TYPE,
  );
  if (!agent || launched) return { message, skills };
  // A title past the part's limit would make the server refuse the whole message.
  const max = agentPromptDataSchema.shape.title.maxLength ?? agent.label.length;
  return {
    message: {
      ...(message as object),
      parts: [
        ...parts,
        {
          type: AGENT_PROMPT_PART_TYPE,
          data: { name: agent.id, title: agent.label.slice(0, max) },
        },
      ],
    } as M,
    skills,
  };
}
