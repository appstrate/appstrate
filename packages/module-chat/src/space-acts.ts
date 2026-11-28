// SPDX-License-Identifier: Apache-2.0

/**
 * The spaces a turn can act in, with the acts the turn holds in each: facts about the caller, read
 * without a request. Every space is given at the same level of detail: a line each, or, when they
 * do not fit the budget, the spaces grouped by identical acts, or, failing that, a count. None is
 * cut and none is put before another. A pure function of its input, under the system prompt's
 * single cache breakpoint.
 */

import { describeSpace, type NamedSpace, type SpaceAct } from "@appstrate/core/mcp-spaces";

export const SPACES_HEADING = "## Spaces you can act in";

/** About 1k tokens. */
export const CHAT_CONTEXT_SPACES_BUDGET_CHARS = 4_000;

/** A space of the turn as the context block names it: its line, then what the turn may do there. */
export type ContextSpace = NamedSpace & { can: readonly SpaceAct[] };

const actsText = (can: readonly SpaceAct[]): string =>
  can.length > 0 ? can.join(", ") : "nothing but looking things up";

/** {@link describeSpace} followed by what the turn may do there. */
export function describeSpaceActs(space: ContextSpace): string {
  return `${describeSpace(space)} — can: ${actsText(space.can)}`;
}

export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One line per distinct set of acts, naming every space that has it, sorted. */
function groupedLines(spaces: readonly ContextSpace[]): string[] {
  const byActs = new Map<string, ContextSpace[]>();
  for (const space of spaces) {
    const key = actsText(space.can);
    byActs.set(key, [...(byActs.get(key) ?? []), space]);
  }
  return [...byActs.keys()].sort(compare).map((key) => {
    const named = byActs
      .get(key)!
      .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
      .map(describeSpace);
    return `- can: ${key} — ${named.join("; ")}`;
  });
}

/** The section naming `spaces` and their acts, at the most detailed level that fits `budget`. */
export function formatSpaces(
  spaces: readonly ContextSpace[],
  budget = CHAT_CONTEXT_SPACES_BUDGET_CHARS,
): string {
  if (spaces.length === 0) return "";
  const render = (lines: string[]) => [SPACES_HEADING, ...lines].join("\n");
  const full = render(spaces.map((space) => `- ${describeSpaceActs(space)}`));
  if (full.length <= budget) return full;
  const grouped = render(groupedLines(spaces));
  if (grouped.length <= budget) return grouped;
  return render([
    `${spaces.length} spaces, not listed here for room: \`get_me\` lists them with their \`can\`.`,
  ]);
}
