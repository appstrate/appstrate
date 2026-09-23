// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn indexes. Pure and order-independent: the index sits
// in the system prompt's single `cache_control` block.

export interface SkillHint {
  package_id: string;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
}

/** Every pin is rendered on every turn, so this is a context-budget bound. */
export const MAX_PINNED_SKILLS = 20;

export interface ChatSkillSelection {
  /** Whether the turn also lists the space's catalogue (pins always are). */
  catalogue: boolean;
  pinned: readonly string[];
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = { catalogue: true, pinned: [] };

export interface ResolveChatSkillsInput {
  selection: ChatSkillSelection;
  /** `/api/me/context` fields: `requested_skills` (the pins that resolved) and `skills`. */
  requested: readonly SkillHint[];
  catalogue: readonly SkillHint[];
  catalogueTruncated: boolean;
}

interface ResolvedChatSkills {
  pinned: SkillHint[];
  catalogue: SkillHint[];
  catalogueTruncated: boolean;
  notices: string[];
}

function byPackageId(a: { package_id: string }, b: { package_id: string }): number {
  return a.package_id < b.package_id ? -1 : a.package_id > b.package_id ? 1 : 0;
}

export function resolveChatSkills(input: ResolveChatSkillsInput): ResolvedChatSkills {
  const { selection } = input;
  const wanted = new Set(selection.pinned);

  const byId = new Map<string, SkillHint>();
  for (const hint of input.requested) {
    if (wanted.has(hint.package_id)) byId.set(hint.package_id, hint);
  }

  // A pin is the user's own act, so the model is told when it no longer resolves.
  const notices = [...wanted]
    .filter((id) => !byId.has(id))
    .sort()
    .map(
      (id) =>
        `The skill \`${id}\` is pinned to this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
    );

  return {
    pinned: [...byId.values()].sort(byPackageId),
    catalogue: selection.catalogue
      ? input.catalogue.filter((hint) => !byId.has(hint.package_id))
      : [],
    catalogueTruncated: selection.catalogue && input.catalogueTruncated,
    notices,
  };
}
