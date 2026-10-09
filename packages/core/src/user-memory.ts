// SPDX-License-Identifier: Apache-2.0

/**
 * The assistant's memory of a PERSON: one memory per platform user, across
 * every organization they belong to. Not an agent's memory (that is
 * `package_persistence`, keyed by package, space and actor).
 *
 * Each memory carries its origin: the organization it was learned in, or none
 * when it is about the person themselves. The chat loads the CORE (no origin +
 * the current organization) into its prompt, and that is all it ever reads:
 * what was learned in one organization stays in it.
 *
 * Shared by the API (validation, the MCP tool), the chat module (rendering)
 * and the SPA, so the vocabulary and the bounds are stated once.
 */

/** What a memory is about. The order is the rendering order. */
export const USER_MEMORY_TYPES = [
  "preference",
  "person",
  "project",
  "goal",
  "commitment",
  "fact",
] as const;
export type UserMemoryType = (typeof USER_MEMORY_TYPES)[number];

/** One memory: a sentence or two. */
export const USER_MEMORY_CONTENT_MAX_CHARS = 500;
/** A subject label ("health", "Tastet", "accounting"). */
export const USER_MEMORY_SUBJECT_MAX_CHARS = 60;

/**
 * Bounds of the CORE, in content characters. A write that would push its half
 * past the bound is refused: the writer condenses first (merge, drop what is
 * stale), which keeps the prompt small without any background pass.
 * The order of magnitude is Hermes Agent's (~2,200 + ~1,375 characters).
 */
export const USER_MEMORY_PERSONAL_BUDGET_CHARS = 2000;
export const USER_MEMORY_ORG_BUDGET_CHARS = 2000;

/**
 * Every value a rendering interpolates is written by someone: a memory by the
 * person or the model, an organization's name by any of its admins. Each is
 * flattened to one line so none can open a heading or a list item of its own
 * and pass for another part of the document the model reads.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** An organization's name as a heading shows it: one line, quoted, bounded. */
function orgLabel(name: string | undefined): string | undefined {
  const flat = name ? oneLine(name).slice(0, 80) : "";
  return flat ? `"${flat.replace(/"/g, "'")}"` : undefined;
}

/** The fields a rendering reads: what the chat's context and the MCP tool both hold. */
export interface RenderableUserMemory {
  id: string;
  type: UserMemoryType;
  subject: string | null;
  content: string;
  /** Origin: null = about the person. */
  orgId: string | null;
}

/**
 * The memory as the model reads it: one Markdown document, about the person
 * first, then what was learned in each organization, by type. `withIds` prefixes
 * each line with its id, for a writer that will `replace` or `remove` it.
 * `orgNames` labels an origin; an unnamed one is shown by its id.
 */
export function renderUserMemories(
  memories: readonly RenderableUserMemory[],
  opts: { withIds?: boolean; orgNames?: Readonly<Record<string, string>> } = {},
): string {
  const line = (m: RenderableUserMemory) =>
    `- ${opts.withIds ? `[${m.id}] ` : ""}(${m.type}${m.subject ? `, ${oneLine(m.subject)}` : ""}) ${oneLine(m.content)}`;
  const byType = (a: RenderableUserMemory, b: RenderableUserMemory) =>
    USER_MEMORY_TYPES.indexOf(a.type) - USER_MEMORY_TYPES.indexOf(b.type);
  const origins = [...new Set(memories.map((m) => m.orgId))].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : 0,
  );
  return origins
    .map((orgId) => {
      const heading =
        orgId === null
          ? "### About the person"
          : `### Learned in ${orgLabel(opts.orgNames?.[orgId]) ?? `organization ${orgId}`}`;
      const lines = memories
        .filter((m) => m.orgId === orgId)
        .sort(byType)
        .map(line);
      return [heading, ...lines].join("\n");
    })
    .join("\n\n");
}
