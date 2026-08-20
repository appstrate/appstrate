// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { isUnlisted, VISIBILITY_META_NAMESPACE } from "../../src/lib/package-visibility.ts";
import {
  formatAssistantSkillsSection,
  isAssistantSkill,
} from "../../src/services/assistant-skills.ts";

const unlistedMeta = { [VISIBILITY_META_NAMESPACE]: { level: "unlisted" } };

describe("isUnlisted", () => {
  it("keeps an unlisted package out of discovery without changing its identity", () => {
    expect(isUnlisted({ name: "@appstrate/copilot", _meta: unlistedMeta })).toBe(true);
  });

  it("keeps packages listed unless the vendor extension explicitly opts out", () => {
    expect(isUnlisted({ name: "@acme/skill" })).toBe(false);
    expect(isUnlisted({ _meta: { [VISIBILITY_META_NAMESPACE]: { level: "public" } } })).toBe(false);
    expect(isUnlisted({ _meta: { [VISIBILITY_META_NAMESPACE]: "unlisted" } })).toBe(false);
    expect(isUnlisted(null)).toBe(false);
  });
});

describe("assistant skill discovery", () => {
  it("uses an explicit assistant role independent from visibility", () => {
    expect(
      isAssistantSkill({ _meta: { "dev.appstrate/assistant-skill": { enabled: true } } }),
    ).toBe(true);
    expect(isAssistantSkill({ _meta: unlistedMeta })).toBe(false);
  });

  it("renders a compact on-demand index instead of full skill content", () => {
    const section = formatAssistantSkillsSection([
      {
        package_id: "@appstrate/copilot",
        display_name: "Copilote",
        description: "Concevoir une automatisation avec l’utilisateur.",
      },
    ]);

    expect(section).toStartWith("## Assistant skills");
    expect(section).toContain('`operation_id: "getSkill"`');
    expect(section).toContain("- `@appstrate/copilot`: Copilote: Concevoir une automatisation");
    expect(section).not.toContain("SKILL.md");
    expect(formatAssistantSkillsSection([])).toBe("");
  });
});
