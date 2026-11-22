// SPDX-License-Identifier: Apache-2.0

/**
 * What sending a message does with the skills and the agent it names. The text keeps the
 * directives as typed (the bubble draws them as chips); the send reads them: each skill joins the
 * conversation's pinned skills, and the agent becomes the message's agent prompt part, which the
 * server resolves with `prompts/get`. A directive carries no authority of its own: the selection
 * and the part are what the server validates.
 */

import { AGENT_PROMPT_PART_TYPE, agentPromptDataSchema } from "../agent-prompt.ts";
import { AGENT_DIRECTIVE, SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import { MAX_PINNED_SKILLS } from "../skills.ts";

/** Why a draft cannot be sent as it is, `null` when it can. */
export type DraftIssue = "agents" | "pins";

/**
 * At most one agent per message (it starts one metered run), and no more skills than the
 * selection has room for. The menu offers neither past its limit; this catches a directive pasted
 * in, and the composer then keeps the draft and says why.
 */
export function draftIssue(text: string, pinned: readonly string[]): DraftIssue | null {
  const named = directivesOf(text);
  if (named.filter((d) => d.type === AGENT_DIRECTIVE).length > 1) return "agents";
  const skills = new Set([
    ...pinned,
    ...named.filter((d) => d.type === SKILL_DIRECTIVE).map((d) => d.id),
  ]);
  return skills.size > MAX_PINNED_SKILLS ? "pins" : null;
}

/** `pinned`, then the skills not in it yet; `pinned` itself when nothing joins. The cap is `draftIssue`'s. */
export function mergePinned(
  pinned: readonly string[],
  skills: readonly string[],
): readonly string[] {
  const added = skills.filter((id, i) => !pinned.includes(id) && skills.indexOf(id) === i);
  return added.length === 0 ? pinned : [...pinned, ...added];
}

/** Whether a text launches an agent: such a draft is not queued behind a running turn. */
export function namesAgent(text: string): boolean {
  return directivesOf(text).some((d) => d.type === AGENT_DIRECTIVE);
}

/**
 * The message a send hands the chat, and the skills it names. The first agent directive joins the
 * message as its agent prompt part, unless it carries one already (a replayed launch).
 */
export function sendWithDirectives<M>(message: M): { message: M; skills: string[] } {
  const parts = (message as { parts?: unknown } | undefined)?.parts;
  if (!Array.isArray(parts)) return { message, skills: [] };
  const text = parts
    .flatMap((part: { type?: unknown; text?: unknown } | null) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
  const named = directivesOf(text);
  const skills = [...new Set(named.flatMap((d) => (d.type === SKILL_DIRECTIVE ? [d.id] : [])))];
  const agent = named.find((d) => d.type === AGENT_DIRECTIVE);
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
