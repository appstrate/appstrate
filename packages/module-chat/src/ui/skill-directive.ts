// SPDX-License-Identifier: Apache-2.0

/**
 * The `/skill` directive — a FIXED CONTRACT WITH THE SERVER, not a rendering
 * detail. assistant-ui's `unstable_defaultDirectiveFormatter` writes
 * `:skill[<label>]{name=<id>}` but DROPS `{name=…}` when the label equals the
 * id, so every label carries a `/` prefix (`/copilot`) that a package id never
 * can. The server (`src/skill-mentions.ts`) parses that string out of the
 * PERSISTED user text, which is why the text is only ever re-presented, never
 * rewritten — and why the bubble splits it with the server's OWN parser rather
 * than a second regex here. React-free, so both halves are tested together.
 */

import type { Unstable_Mention } from "@assistant-ui/react";
import { parseSkillMentions } from "../skill-mentions.ts";
import type { ChatSkillEntry } from "./chat-skills.ts";

const SKILL_DIRECTIVE_TYPE = "skill";

function namePart(packageId: string): string {
  const slash = packageId.indexOf("/");
  return slash === -1 ? packageId : packageId.slice(slash + 1);
}

function scopePart(packageId: string): string {
  const slash = packageId.indexOf("/");
  return slash === -1 ? "" : packageId.slice(0, slash);
}

/** The catalogue as mention items; the scope is appended to COLLIDING labels only. */
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
      metadata: { source: skill.source },
    };
  });
}

type SkillTextSegment =
  { kind: "text"; text: string } | { kind: "skill"; label: string; id: string };

/** Split a persisted text on its directives — the prose runs are the literal gaps. */
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
