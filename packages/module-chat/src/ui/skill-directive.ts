// SPDX-License-Identifier: Apache-2.0

// Mention items, parsed back by the server's `parseSkillMentions`. The formatter
// drops `{name=…}` when label === id, so every label starts with `/`; an id never does.

import type { Unstable_Mention } from "@assistant-ui/react";
import { parseScopedName } from "@appstrate/core/naming";
import type { SkillHint } from "../skills.ts";

const SKILL_DIRECTIVE_TYPE = "skill";

/** The scope is appended to COLLIDING labels only. */
export function skillMentionItems(skills: readonly SkillHint[]): Unstable_Mention[] {
  const named = skills.map((skill) => {
    const scoped = parseScopedName(skill.package_id);
    return { skill, scope: scoped?.scope ?? null, name: scoped?.name ?? skill.package_id };
  });
  const seen = new Map<string, number>();
  for (const { name } of named) seen.set(name, (seen.get(name) ?? 0) + 1);
  return named.map(({ skill, scope, name }) => {
    const collides = scope !== null && (seen.get(name) ?? 0) > 1;
    return {
      id: skill.package_id,
      type: SKILL_DIRECTIVE_TYPE,
      label: collides ? `/${name} (@${scope})` : `/${name}`,
      ...(skill.description ? { description: skill.description } : {}),
    };
  });
}
