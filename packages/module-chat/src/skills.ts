// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn indexes. Pure and order-independent: the index sits
// in the system prompt's single `cache_control` block.

export interface SkillHint {
  package_id: string;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
}

/** Unlisted system packages every turn indexes, whatever the space holds. */
export const PLATFORM_DEFAULT_SKILLS: readonly string[] = [
  "@appstrate/connector-choice",
  "@appstrate/copilot",
  "@appstrate/web-search",
];

/** Every pin is rendered on every turn, so this is a context-budget bound. */
export const MAX_PINNED_SKILLS = 20;

export interface ChatSkillSelection {
  /** Whether the turn also lists the space's catalogue (defaults and pins always are). */
  catalogue: boolean;
  pinned: readonly string[];
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = { catalogue: true, pinned: [] };

/** `platform`: a default, which guides the chat and is never an agent dependency. */
export interface IndexedSkill extends SkillHint {
  platform: boolean;
  pinned: boolean;
}

export interface ResolveChatSkillsInput {
  selection: ChatSkillSelection;
  defaults: readonly string[];
  /** `/api/me/context` fields: `requested_skills`, `unresolved_skills`, `skills`. */
  requested: readonly SkillHint[];
  unresolved: readonly string[];
  catalogue: readonly SkillHint[];
  catalogueTruncated: boolean;
}

export interface ResolvedChatSkills {
  indexed: IndexedSkill[];
  catalogue: SkillHint[];
  catalogueTruncated: boolean;
  notices: string[];
}

function byPackageId(a: { package_id: string }, b: { package_id: string }): number {
  return a.package_id < b.package_id ? -1 : a.package_id > b.package_id ? 1 : 0;
}

export function resolveChatSkills(input: ResolveChatSkillsInput): ResolvedChatSkills {
  const { selection } = input;
  const defaults = new Set(input.defaults);
  const pinned = new Set(selection.pinned);
  const wanted = new Set([...defaults, ...pinned]);

  const byId = new Map<string, IndexedSkill>();
  for (const hint of input.requested) {
    if (!wanted.has(hint.package_id) || byId.has(hint.package_id)) continue;
    byId.set(hint.package_id, {
      ...hint,
      platform: defaults.has(hint.package_id),
      pinned: pinned.has(hint.package_id),
    });
  }

  // An unresolved pin is the user's own act, so the model is told; an
  // unresolved default is a deployment fault, warned about by the caller.
  const unresolved = new Set(input.unresolved);
  const notices = [...pinned]
    .filter((id) => unresolved.has(id))
    .sort()
    .map(
      (id) =>
        `The skill \`${id}\` is pinned to this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
    );

  return {
    indexed: [...byId.values()].sort(byPackageId),
    catalogue: selection.catalogue
      ? input.catalogue.filter((hint) => !byId.has(hint.package_id))
      : [],
    catalogueTruncated: selection.catalogue && input.catalogueTruncated,
    notices,
  };
}
