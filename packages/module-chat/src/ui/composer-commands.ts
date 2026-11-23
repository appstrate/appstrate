// SPDX-License-Identifier: Apache-2.0

// The composer's `/` menu as pure rules; `composer-popover.tsx` only draws it.

import type { TriggerItem } from "@assistant-ui/core";
import type { ChatCommands } from "../commands.ts";
import { AGENT_DIRECTIVE, SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import {
  exceedsBudget,
  pinIds,
  skillBudget,
  type EffectiveSkills,
  type StoredSkills,
} from "./chat-skills.ts";

interface CommandContext {
  /** The conversation's skills, and those with the draft's citations; `null`: no skill is listed here. */
  skills: { stored: StoredSkills; effective: EffectiveSkills } | null;
  /** A turn runs: the draft will be queued, so no agent is offered. */
  running: boolean;
  draft: string;
}

export interface CommandList {
  items: TriggerItem[];
  /** Skills that would take the pins past their budget: not offered, the menu says why. */
  overBudget: TriggerItem[];
}

/** The skills offered (into the result), those past the budget into `overBudget`. */
function skillItems(
  commands: ChatCommands,
  { stored, effective }: NonNullable<CommandContext["skills"]>,
  overBudget: TriggerItem[],
): TriggerItem[] {
  const pinned = pinIds(stored);
  const bytes = new Map(commands.skills.map((skill) => [skill.id, skill.bytes]));
  const budget = skillBudget(stored, effective, (id) => bytes.get(id) ?? null);
  const offered: TriggerItem[] = [];
  for (const skill of commands.skills) {
    const isPinned = pinned.includes(skill.id);
    const item: TriggerItem = {
      id: skill.id,
      type: SKILL_DIRECTIVE,
      label: skill.name,
      description: skill.description,
      metadata: {
        version: skill.version,
        pinned: isPinned,
        cited: !isPinned && effective.cited.has(skill.id),
      },
    };
    const fits = effective.ids.includes(skill.id) || !exceedsBudget(budget, skill.bytes);
    (fits ? offered : overBudget).push(item);
  }
  return offered;
}

/** Skills then agents; no agent once the draft names one, no new skill past the budget. */
export function commandList(
  commands: ChatCommands,
  { skills, running, draft }: CommandContext,
): CommandList {
  const named = directivesOf(draft);
  const list: CommandList = { items: [], overBudget: [] };
  if (skills) list.items.push(...skillItems(commands, skills, list.overBudget));
  if (!running && !named.some((d) => d.type === AGENT_DIRECTIVE)) {
    for (const agent of commands.agents) {
      list.items.push({
        id: agent.name,
        type: AGENT_DIRECTIVE,
        label: agent.title,
        description: agent.description,
        metadata: {
          appearance: { packageId: agent.packageId, icon: agent.icon, color: agent.color },
        },
      });
    }
  }
  return list;
}

/** 0 exact, 1 prefix, 2 substring of a name (an agent's prompt name too), 3 of the description. */
function rank(query: string, item: TriggerItem): number | null {
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
 * The menu has nothing to show for `query`: no offered entry and no over-budget skill matches it.
 * An over-budget match keeps the menu open, to say why that skill cannot be added, and keeps Enter
 * from sending the `/token`. While the commands load (`list` null) the menu stays open.
 */
export function noCommandMatch(list: CommandList | null, query: string): boolean {
  return (
    list !== null &&
    searchCommands(list.items, query).length === 0 &&
    searchCommands(list.overBudget, query).length === 0
  );
}

/** A `/` starting a word, up to the cursor; not while `closed` (no match: Enter sends `/usr`). */
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
