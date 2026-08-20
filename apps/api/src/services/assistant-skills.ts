// SPDX-License-Identifier: Apache-2.0

import { asRecord } from "@appstrate/core/safe-json";
import { getSystemPackagesByType } from "./system-packages.ts";

export const ASSISTANT_SKILL_META_NAMESPACE = "dev.appstrate/assistant-skill";

export function isAssistantSkill(manifest: Record<string, unknown> | null | undefined): boolean {
  const role = asRecord(asRecord(manifest?._meta)[ASSISTANT_SKILL_META_NAMESPACE]);
  return role.enabled === true;
}

export interface AssistantSkillHint {
  package_id: string;
  display_name: string;
  description: string;
}

export function listAssistantSkills(): AssistantSkillHint[] {
  return getSystemPackagesByType("skill")
    .filter((entry) => isAssistantSkill(entry.manifest))
    .map((entry) => ({
      package_id: entry.packageId,
      display_name:
        typeof entry.manifest.display_name === "string" && entry.manifest.display_name.length > 0
          ? entry.manifest.display_name
          : entry.packageId,
      description: typeof entry.manifest.description === "string" ? entry.manifest.description : "",
    }))
    .sort((left, right) => left.package_id.localeCompare(right.package_id));
}

export function formatAssistantSkillsSection(skills: readonly AssistantSkillHint[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "## Assistant skills",
    "Reusable guides for recurring assistant situations. Choose the most specific guide that " +
      "clearly matches the request. Load one guide at a time, and load none when no guide " +
      'clearly matches. Before acting, call `invoke_operation` with `operation_id: "getSkill"` ' +
      "and split the exact package id into `scope` and `name` path parameters. Keep the leading " +
      "`@` on the scope.",
  ];
  for (const skill of skills) {
    const label = skill.display_name === skill.package_id ? "" : `${skill.display_name}: `;
    lines.push(`- \`${skill.package_id}\`: ${label}${skill.description}`);
  }
  return lines.join("\n");
}

export function buildAssistantSkillsSection(): string {
  return formatAssistantSkillsSection(listAssistantSkills());
}
