// SPDX-License-Identifier: Apache-2.0

/**
 * Which skills a chat turn puts in its index, and in what order.
 *
 * Four sources feed one index — the platform defaults below, the session's
 * pins, the space catalogue, and (phase 4) a `/skill` mention — and this
 * resolver is where they become one deterministic list. It is PURE: the route
 * fetches, this decides, `prompt.ts` renders. That split is what makes the
 * ordering testable without a database.
 *
 * Determinism is the load-bearing property, not a nicety. The rendered index
 * lands in the chat's system prompt, which pi-ai emits as ONE block carrying
 * ONE `cache_control` breakpoint: any byte that moves between turns for the
 * same session state invalidates the cached prefix AND the conversation
 * history behind it. So everything here sorts by package id, and nothing reads
 * a clock, a counter or an insertion order.
 */

/**
 * One skill as `GET /api/me/context` projects it — the `skills` catalogue and
 * the `requested_skills` exact-id resolution share this shape by construction
 * (one SQL projection server-side).
 */
export interface SkillHint {
  package_id: string;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
}

/**
 * Skills every chat turn indexes, whatever the space contains. They are system
 * packages marked `unlisted`, so they serve the assistant without appearing in
 * the user's skill catalogue — the package does not describe its consumer, the
 * consumer names the packages it wants (that is why this is a constant here and
 * not a manifest marker).
 *
 * Sorted, because it is spliced into a request and into the index.
 */
export const PLATFORM_DEFAULT_SKILLS: readonly string[] = [
  "@appstrate/connector-choice",
  "@appstrate/copilot",
  "@appstrate/web-search",
];

/**
 * How much of the space's skill catalogue a session wants in its index. A
 * context-budget control, never a security boundary: `getSkill` stays generic
 * and RBAC-gated whatever is indexed here.
 */
export const SKILL_DISCOVERY_MODES = ["auto", "on_demand", "manual"] as const;
export type SkillDiscovery = (typeof SKILL_DISCOVERY_MODES)[number];

/** What a session that never chose gets: defaults + pins + the catalogue. */
export const DEFAULT_SKILL_DISCOVERY: SkillDiscovery = "auto";

/** The per-session skill choice a turn resolves against. */
export interface ChatSkillSelection {
  discovery: SkillDiscovery;
  /** Package ids the user pinned to this conversation. */
  pinned: readonly string[];
}

/** An indexed skill, tagged with WHY it is in the index. */
export interface IndexedSkill extends SkillHint {
  /** `pinned` wins: a default the user also pinned is the user's choice. */
  origin: "platform" | "pinned";
}

export interface ResolveChatSkillsInput extends ChatSkillSelection {
  /** Platform defaults — {@link PLATFORM_DEFAULT_SKILLS} in every live caller. */
  defaults: readonly string[];
  /** `requested_skills`: the ids that resolved, whatever their visibility. */
  requested: readonly SkillHint[];
  /** `unresolved_skills`: requested ids no package answered. */
  unresolved: readonly string[];
  /** `skills`: the space's capped, listed-only catalogue. */
  catalogue: readonly SkillHint[];
  catalogueTruncated: boolean;
}

export interface ResolvedChatSkills {
  /** Name + description in the prompt; the body loads on demand via `getSkill`. */
  indexed: IndexedSkill[];
  /** The catalogue minus what is already indexed — empty unless discovery is `auto`. */
  catalogue: SkillHint[];
  catalogueTruncated: boolean;
  /** One line per unresolved PIN, rendered as prose after the index. */
  notices: string[];
}

/** Total order on package ids — the index's only ranking. */
function byPackageId(a: { package_id: string }, b: { package_id: string }): number {
  return a.package_id < b.package_id ? -1 : a.package_id > b.package_id ? 1 : 0;
}

export function resolveChatSkills(input: ResolveChatSkillsInput): ResolvedChatSkills {
  // `discovery` reaches this resolver from persisted per-session state, so it
  // is checked rather than trusted: an unknown mode degrades to the default
  // instead of silently indexing nothing.
  const discovery: SkillDiscovery = SKILL_DISCOVERY_MODES.includes(input.discovery)
    ? input.discovery
    : DEFAULT_SKILL_DISCOVERY;

  const pinned = new Set(input.pinned);
  // `manual` indexes the user's pins and nothing else — not even the platform
  // defaults, which is the whole difference between it and `on_demand`.
  const wanted = discovery === "manual" ? pinned : new Set([...input.defaults, ...pinned]);

  const byId = new Map<string, IndexedSkill>();
  for (const hint of input.requested) {
    if (!wanted.has(hint.package_id) || byId.has(hint.package_id)) continue;
    byId.set(hint.package_id, {
      ...hint,
      origin: pinned.has(hint.package_id) ? "pinned" : "platform",
    });
  }
  const indexed = [...byId.values()].sort(byPackageId);

  // The catalogue is the long tail, so it never repeats what is already
  // indexed; outside `auto` it is not shown at all.
  const catalogue =
    discovery === "auto" ? input.catalogue.filter((hint) => !byId.has(hint.package_id)) : [];

  // A PIN that does not resolve is the user's own act and must be visible to
  // them, so it becomes a line in the prompt. An unresolved DEFAULT is a
  // deployment concern — silently dropped here, warned about by the caller.
  const unresolved = new Set(input.unresolved);
  const notices = [...new Set(input.pinned)]
    .filter((id) => unresolved.has(id))
    .sort()
    .map(
      (id) =>
        `The skill \`${id}\` is pinned to this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
    );

  return {
    indexed,
    catalogue: [...catalogue],
    catalogueTruncated: discovery === "auto" ? input.catalogueTruncated : false,
    notices,
  };
}
