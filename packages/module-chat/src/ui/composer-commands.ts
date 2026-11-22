// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu as pure rules: what it lists for the draft, how a query ranks it, and
 * when the text before the cursor opens it. The popover (`composer-popover.tsx`) only draws it.
 */

import type { TriggerItem } from "@assistant-ui/core";
import type { ChatCommands } from "../commands.ts";
import { AGENT_DIRECTIVE, SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import { effectiveSkills } from "./chat-skills.ts";

export interface CommandContext {
  /** The conversation's pinned skills; `null`: its selection cannot be changed here, no skill is listed. */
  pinned: readonly string[] | null;
  /** A turn is running: what is typed is queued as plain text, so no agent is launched. */
  running: boolean;
  /** The draft: the skills and the agent it already names count against the cap and the one agent. */
  draft: string;
}

export interface CommandList {
  /** What the menu offers, skills then agents. */
  items: TriggerItem[];
  /** Skills that would be a sixth pin: not offered, the menu says why. */
  capped: TriggerItem[];
}

/**
 * Skills (their package id is the item id, the name the label), then agents (prompt name as id,
 * title as label). A skill the selection and the draft do not hold yet is capped once they hold
 * {@link MAX_PINNED_SKILLS}; at most one agent per message, so none is offered once the draft
 * names one.
 */
export function commandList(
  commands: ChatCommands,
  { pinned, running, draft }: CommandContext,
): CommandList {
  const named = directivesOf(draft);
  const { ids, atCap } = effectiveSkills(
    pinned ?? [],
    named.flatMap((d) => (d.type === SKILL_DIRECTIVE ? [d.id] : [])),
  );
  const list: CommandList = { items: [], capped: [] };
  for (const skill of pinned === null ? [] : commands.skills) {
    const item: TriggerItem = {
      id: skill.id,
      type: SKILL_DIRECTIVE,
      label: skill.name,
      description: skill.description,
      metadata: { version: skill.version, added: ids.includes(skill.id) },
    };
    (ids.includes(skill.id) || !atCap ? list.items : list.capped).push(item);
  }
  if (!running && !named.some((d) => d.type === AGENT_DIRECTIVE)) {
    for (const agent of commands.agents) {
      list.items.push({
        id: agent.name,
        type: AGENT_DIRECTIVE,
        label: agent.title,
        description: agent.description,
      });
    }
  }
  return list;
}

/** 0 exact, 1 prefix, 2 substring of a name; 3 a substring of the description; `null`: no match. */
function rank(query: string, item: TriggerItem): number | null {
  // An agent is also typed by its prompt name (`run-…`).
  const names = [item.label, ...(item.type === AGENT_DIRECTIVE ? [item.id] : [])].map((n) =>
    n.toLowerCase(),
  );
  if (names.includes(query)) return 0;
  if (names.some((n) => n.startsWith(query))) return 1;
  if (names.some((n) => n.includes(query))) return 2;
  return item.description?.toLowerCase().includes(query) ? 3 : null;
}

/** The items matching `query` (case-insensitive), skills then agents, best rank first in each. */
export function searchCommands(items: readonly TriggerItem[], query: string): TriggerItem[] {
  const q = query.toLowerCase();
  return items
    .flatMap((item, index) => {
      const r = rank(q, item);
      return r === null ? [] : [{ item, r, index }];
    })
    .sort(
      (x, y) =>
        Number(x.item.type === AGENT_DIRECTIVE) - Number(y.item.type === AGENT_DIRECTIVE) ||
        x.r - y.r ||
        x.index - y.index,
    )
    .map(({ item }) => item);
}

/**
 * Where the trigger opens: a `/` that starts a word, up to the cursor. Not while `closed`: nothing
 * matches the query, so Enter sends the text (`/usr`, a path) instead of waiting on a menu with
 * nothing in it.
 */
export function slashMatch(
  text: string,
  cursor: number,
  closed: (query: string) => boolean,
): { query: string; offset: number; endOffset: number } | null {
  const found = /(^|\s)\/(\S*)$/.exec(text.slice(0, cursor));
  if (!found) return null;
  const query = found[2]!;
  if (closed(query)) return null;
  return { query, offset: found.index + found[1]!.length, endOffset: cursor };
}
