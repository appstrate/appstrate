// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu, as pure rules: when it opens, what it lists, what a key does and what
 * choosing an entry means. The component (`slash-menu.tsx`) only applies the answers.
 */

import type { ChatAgentCommand, ChatCommands, ChatSkillCommand } from "../commands.ts";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import type { AgentChip } from "./agent-prompt-part.ts";
import { togglePinned } from "./chat-skills.ts";

/**
 * The text after `/` while the menu is open: the draft is one `/token`, no whitespace yet.
 * `null`: the draft is anything else, an ordinary message.
 */
export function slashQuery(text: string): string | null {
  return /^\/\S*$/.test(text) ? text.slice(1) : null;
}

export type SlashEntry =
  /** `pinned`: already in the selection; `capped`: not pinnable, the selection is full. */
  | { kind: "skill"; skill: ChatSkillCommand; state: "free" | "pinned" | "capped" }
  | { kind: "agent"; agent: ChatAgentCommand };

export interface SlashContext {
  pinned: readonly string[];
  /** A turn is running: what is typed is queued as plain text, so no agent is launched. */
  running: boolean;
  /** The conversation's selection can be changed from here. */
  canPin: boolean;
}

function matches(query: string, ...fields: string[]): boolean {
  return fields.some((field) => field.toLowerCase().includes(query));
}

/** Skills, then agents, those matching `query` (case-insensitive) on their name or description / title. */
export function slashEntries(
  commands: ChatCommands,
  query: string,
  { pinned, running, canPin }: SlashContext,
): SlashEntry[] {
  const q = query.toLowerCase();
  const skills = canPin
    ? commands.skills
        .filter((skill) => matches(q, skill.name, skill.description))
        .map((skill): SlashEntry => {
          const state = pinned.includes(skill.id)
            ? "pinned"
            : pinned.length >= MAX_PINNED_SKILLS
              ? "capped"
              : "free";
          return { kind: "skill", skill, state };
        })
    : [];
  const agents = running
    ? []
    : commands.agents
        .filter((agent) => matches(q, agent.name, agent.title))
        .map((agent): SlashEntry => ({ kind: "agent", agent }));
  return [...skills, ...agents];
}

/** What a key does to an open menu of `count` (> 0) entries; `null`: the key is not the menu's. */
export function slashKey(
  key: string,
  active: number,
  count: number,
): { active: number; action?: "select" | "close" } | null {
  switch (key) {
    case "ArrowDown":
      return { active: (active + 1) % count };
    case "ArrowUp":
      return { active: (active - 1 + count) % count };
    case "Enter":
    case "Tab":
      return { active, action: "select" };
    case "Escape":
      return { active, action: "close" };
    default:
      return null;
  }
}

export type SlashChoice =
  /** The selection becomes `pinned`; the token goes. */
  | { kind: "pin"; pinned: string[] }
  /** The agent becomes the composer's chip; the token goes. */
  | { kind: "agent"; agent: AgentChip }
  /** Nothing to change (already pinned); the token goes. */
  | { kind: "close" }
  /** The selection is full: the menu stays, the draft is kept. */
  | { kind: "refuse" };

export function slashChoice(entry: SlashEntry, pinned: readonly string[]): SlashChoice {
  if (entry.kind === "agent") {
    return { kind: "agent", agent: { name: entry.agent.name, title: entry.agent.title } };
  }
  if (entry.state === "pinned") return { kind: "close" };
  if (entry.state === "capped") return { kind: "refuse" };
  return { kind: "pin", pinned: togglePinned(pinned, entry.skill.id) };
}
