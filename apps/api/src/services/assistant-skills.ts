// SPDX-License-Identifier: Apache-2.0

/**
 * Assistant skills — UNLISTED system skill packages that carry know-how for the
 * chat assistant (copilot interview, web search recipe, connector choice, …).
 *
 * They are ordinary `.afps` skill packages in `system-packages/`, synced at
 * boot like every system package, but marked unlisted via the
 * `_meta["dev.appstrate/visibility"]` extension so they never surface in the
 * package catalogue or the "attach to an agent" hints. The assistant discovers
 * them through two dedicated indexes — the platform MCP server instructions and
 * the chat caller-context block — and loads a skill's full instructions on
 * demand by exact id (`invoke_operation` → `getSkill`), the same progressive
 * disclosure the detail route already provides for any system package.
 */

import { getSystemPackagesByType } from "./system-packages.ts";
import { isUnlisted } from "../lib/package-visibility.ts";

/** One assistant-skill entry for the MCP-instructions / chat-context indexes. */
export interface AssistantSkillHint {
  /** Exact package id, e.g. "@appstrate/copilot" — load via `getSkill`. */
  package_id: string;
  display_name: string;
  /** When-to-use trigger — the only text the model sees before loading. */
  description: string;
}

/**
 * List the assistant skills known to this instance: system skills marked
 * unlisted. Reads the in-memory system-package registry (loaded once at boot),
 * so it is synchronous and free — safe on the get_me / MCP-initialize hot
 * paths. Sorted by id for deterministic prompt output.
 */
export function listAssistantSkills(): AssistantSkillHint[] {
  return getSystemPackagesByType("skill")
    .filter((entry) => isUnlisted(entry.manifest))
    .map((entry) => {
      const manifest = entry.manifest;
      return {
        package_id: entry.packageId,
        display_name:
          typeof manifest.display_name === "string" && manifest.display_name.length > 0
            ? manifest.display_name
            : entry.packageId,
        description: typeof manifest.description === "string" ? manifest.description : "",
      };
    })
    .sort((a, b) => a.package_id.localeCompare(b.package_id));
}

/**
 * Render the `## Assistant skills` markdown section from a list of hints.
 * Returns "" when there is nothing to index so callers can skip the section.
 * Pure — the registry-reading wrapper is {@link buildAssistantSkillsSection}.
 */
export function formatAssistantSkillsSection(skills: readonly AssistantSkillHint[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "## Assistant skills",
    "Reusable instruction sets for recurring assistant situations. When one matches the " +
      "situation, load its full instructions BEFORE acting: call `invoke_operation` with " +
      '`operation_id: "getSkill"` and `path_params: { "scope": "<@scope>", "name": "<name>" }` ' +
      "(split the skill's `@scope/name` id, KEEP the leading `@` on the scope), read the " +
      "returned `content`, and follow it.",
  ];
  for (const s of skills) {
    const label = s.display_name !== s.package_id ? `${s.display_name}: ` : "";
    lines.push(`- \`${s.package_id}\` — ${label}${s.description}`);
  }
  return lines.join("\n");
}

/**
 * The `## Assistant skills` section for the platform MCP server instructions —
 * injected BEFORE the operation index so it survives the chat's per-provider
 * index trim (`applyOperationIndexPolicy`). "" when no assistant skill is
 * loaded (e.g. a deployment that stripped them from `system-packages/`).
 */
export function buildAssistantSkillsSection(): string {
  return formatAssistantSkillsSection(listAssistantSkills());
}
