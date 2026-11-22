// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu, as pure rules: when it opens, what it lists, what a key does and what
 * choosing an entry means. The component (`slash-menu.tsx`) only applies the answers.
 */

import type { ChatAgentCommand, ChatCommands, ChatSkillCommand } from "../commands.ts";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import { agentPromptDataSchema } from "../agent-prompt.ts";
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

/** 0 exact, 1 prefix, 2 substring of `name`; 3 a substring of `other`; `null`: no match. */
function rank(query: string, name: string, other: string): number | null {
  const n = name.toLowerCase();
  if (n === query) return 0;
  if (n.startsWith(query)) return 1;
  if (n.includes(query)) return 2;
  return other.toLowerCase().includes(query) ? 3 : null;
}

/** The matching `items`, best rank first (the listed order within a rank). */
function ranked<T>(items: readonly T[], rankOf: (item: T) => number | null): T[] {
  return items
    .flatMap((item, index) => {
      const r = rankOf(item);
      return r === null ? [] : [{ item, r, index }];
    })
    .sort((x, y) => x.r - y.r || x.index - y.index)
    .map(({ item }) => item);
}

/**
 * Skills, then agents, those matching `query` (case-insensitive), each section ranked: exact
 * name, name prefix, name substring, then description (skills) or title (agents).
 */
export function slashEntries(
  commands: ChatCommands,
  query: string,
  { pinned, running, canPin }: SlashContext,
): SlashEntry[] {
  const q = query.toLowerCase();
  const skills = canPin
    ? ranked(commands.skills, (skill) => rank(q, skill.name, skill.description)).map(
        (skill): SlashEntry => {
          const state = pinned.includes(skill.id)
            ? "pinned"
            : pinned.length >= MAX_PINNED_SKILLS
              ? "capped"
              : "free";
          return { kind: "skill", skill, state };
        },
      )
    : [];
  const agents = running
    ? []
    : ranked(commands.agents, (agent) => rank(q, agent.name, agent.title)).map(
        (agent): SlashEntry => ({ kind: "agent", agent }),
      );
  return [...skills, ...agents];
}

/**
 * A draft that starts with `/<name>` then whitespace or its end, where `<name>` is exactly the
 * name of ONE listed skill or agent (a homonym is ambiguous: plain text): the entry, and the rest
 * of the draft, which is the message. The composer is the only parser of a command.
 */
export function parseTypedCommand(
  text: string,
  commands: ChatCommands,
  { pinned, running, canPin }: SlashContext,
): { entry: SlashEntry; rest: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const exact = slashEntries(commands, match[1]!, { pinned, running, canPin }).filter(
    (entry) => (entry.kind === "skill" ? entry.skill.name : entry.agent.name) === match[1],
  );
  return exact.length === 1 ? { entry: exact[0]!, rest: match[2] ?? "" } : null;
}

/**
 * What sending a typed command does once its choice is applied (`rest` is the draft left):
 * `stay` when nothing is sent (the pin was refused, or only a skill was named), `agent-only` for
 * an agent named alone (the composer sends no empty draft), `send` for a message to send.
 */
export function typedSendPlan(
  choice: SlashChoice,
  rest: string,
  hasAttachments: boolean,
): "stay" | "agent-only" | "send" {
  if (choice.kind === "refuse") return "stay";
  if (rest.trim() !== "" || hasAttachments) return "send";
  return choice.kind === "agent" ? "agent-only" : "stay";
}

/** Escape closes the menu for the draft it was pressed on only: any other text forgets it. */
export function dismissalFor(dismissed: string | null, text: string): string | null {
  return dismissed === text ? dismissed : null;
}

/** An IME keydown (Safari confirms a composition with keyCode 229): it is not the menu's. */
export function isComposingKey(event: { keyCode: number; nativeEvent: { isComposing: boolean } }) {
  return event.nativeEvent.isComposing || event.keyCode === 229;
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
    // A title past the part's limit would make the server refuse the whole message.
    const max = agentPromptDataSchema.shape.title.maxLength ?? entry.agent.title.length;
    return {
      kind: "agent",
      agent: { name: entry.agent.name, title: entry.agent.title.slice(0, max) },
    };
  }
  if (entry.state === "pinned") return { kind: "close" };
  if (entry.state === "capped") return { kind: "refuse" };
  return { kind: "pin", pinned: togglePinned(pinned, entry.skill.id) };
}
