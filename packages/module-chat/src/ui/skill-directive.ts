// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue as `/skill` mention items — a FIXED CONTRACT WITH THE SERVER,
 * not a rendering detail. assistant-ui's `unstable_defaultDirectiveFormatter`
 * writes `:skill[<label>]{name=<id>}` but DROPS `{name=…}` when the label
 * equals the id, so every label carries a `/` prefix (`/copilot`) that a
 * package id never can. The server (`src/skill-mentions.ts`) parses that string
 * back out of the PERSISTED user text — which is why the text is only ever
 * re-presented, never rewritten, and why the bubble splits it with the server's
 * OWN `splitSkillDirectives` rather than a second regex here.
 */

import type { Unstable_Mention } from "@assistant-ui/react";
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
