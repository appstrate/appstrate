// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` directive: the exact string the composer writes and the server
 * reads back, and the two pure functions that produce and undo it.
 *
 * This is a FIXED CONTRACT WITH THE SERVER, not a rendering detail.
 * assistant-ui's `unstable_defaultDirectiveFormatter` serialises a trigger item
 * as `:${type}[${label}]{name=${id}}` and DROPS the `{name=…}` attribute when
 * the id equals the label — so the label carries the `/` prefix (`/copilot`)
 * while the id stays the package id (`@appstrate/copilot`), two namespaces that
 * can never collide. The server (`src/skill-mentions.ts`) parses exactly
 * `:skill[<label>]{name=@scope/name}` out of the PERSISTED user text and
 * injects the SKILL.md body into the turn, which is why the text is never
 * rewritten for display — only re-presented (`splitSkillDirectives`).
 *
 * Reading is NOT mirrored here: the bubble splits its text with the SERVER's
 * own `parseSkillMentions` (`../skill-mentions.ts`, a pure function over a
 * string), so "what the user sees as a chip" and "what the turn resolves" are
 * one decision instead of two regexes that agree until one of them is edited.
 *
 * Split out of `skill-mention.tsx` so it can be tested — and imported — without
 * React: `test/skill-mention-items.test.ts` feeds a real serialised item to
 * that same server parser, which is the only place the two halves of the
 * contract meet.
 */

import type { Unstable_Mention } from "@assistant-ui/react";
import { parseSkillMentions } from "../skill-mentions.ts";
import type { ChatSkillEntry } from "./chat-skills.ts";

/** The directive type the server accepts. Anything else stays prose. */
const SKILL_DIRECTIVE_TYPE = "skill";

/** `@scope/name` → `name`; an id without a scope is its own name part. */
function namePart(packageId: string): string {
  const slash = packageId.indexOf("/");
  return slash === -1 ? packageId : packageId.slice(slash + 1);
}

/** `@scope/name` → `@scope`; `""` when the id carries no scope. */
function scopePart(packageId: string): string {
  const slash = packageId.indexOf("/");
  return slash === -1 ? "" : packageId.slice(0, slash);
}

/**
 * The catalogue as mention items.
 *
 * The label is what the popover row shows AND what the formatter writes between
 * the brackets, so it must (a) read like a command — `/copilot` — and (b) never
 * equal the id, or the formatter drops `{name=…}` and the server loses the
 * package id. A leading `/` guarantees (b) for every `@scope/name`.
 *
 * Two skills can share a name part across scopes (`@appstrate/copilot` and
 * `@acme/copilot`). Both are kept — the id disambiguates them for the server —
 * and the scope is appended to the COLLIDING labels only, so the common case
 * stays short.
 */
export function skillMentionItems(skills: readonly ChatSkillEntry[]): Unstable_Mention[] {
  const seen = new Map<string, number>();
  for (const skill of skills) {
    const name = namePart(skill.package_id);
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  return skills.map((skill) => {
    const name = namePart(skill.package_id);
    const scope = scopePart(skill.package_id);
    const collides = (seen.get(name) ?? 0) > 1 && scope !== "";
    return {
      id: skill.package_id,
      type: SKILL_DIRECTIVE_TYPE,
      label: collides ? `/${name} (${scope})` : `/${name}`,
      description: skill.description,
      // Read back by the popover row: `source` is the only thing it shows
      // beyond the label and the description.
      metadata: { source: skill.source },
    };
  });
}

/**
 * A user text part split for rendering: the runs of prose, and the skill
 * mentions that become chips. Anything the server will not resolve — a
 * directive of another type, a malformed package id, a `{name=…}` the author
 * never wrote — is simply not a mention, so it stays inside its prose run.
 */
type SkillTextSegment =
  { kind: "text"; text: string } | { kind: "skill"; label: string; id: string };

/**
 * Split a persisted user text on its skill directives.
 *
 * The bubble is the only place a user ever sees what was persisted, so this
 * must not drop, reorder or rewrite a single character — `raw` and `index`
 * from the server's parser make the prose runs the literal gaps between the
 * matches, which is the strongest form of that guarantee available.
 */
export function splitSkillDirectives(text: string): SkillTextSegment[] {
  const out: SkillTextSegment[] = [];
  let cursor = 0;
  for (const mention of parseSkillMentions(text)) {
    if (mention.index > cursor) out.push({ kind: "text", text: text.slice(cursor, mention.index) });
    out.push({ kind: "skill", label: mention.label, id: mention.id });
    cursor = mention.index + mention.raw.length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}
