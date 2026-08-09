// SPDX-License-Identifier: Apache-2.0

/**
 * Assistant skills: system skill packages explicitly marked as guides for the
 * chat assistant, such as the copilot interview and connector choice.
 *
 * They are ordinary `.afps` skill packages in `system-packages/`, synced at
 * boot like every system package. Their assistant role is declared separately
 * from visibility via `_meta["dev.appstrate/assistant-skill"]`; the five shipped
 * guides are also unlisted so they stay out of attachable-skill catalogues. The
 * assistant discovers them once through the platform MCP server instructions
 * and loads a guide on demand by exact id (`invoke_operation` → `getSkill`).
 */

import { getSystemPackagesByType } from "./system-packages.ts";
import { asRecord } from "@appstrate/core/safe-json";

/** Vendor extension declaring that a system skill guides the chat assistant. */
export const ASSISTANT_SKILL_META_NAMESPACE = "dev.appstrate/assistant-skill";

/** Visibility and assistant role are orthogonal. Only this marker grants the role. */
export function isAssistantSkill(manifest: Record<string, unknown> | null | undefined): boolean {
  const meta = asRecord(asRecord(manifest?._meta)[ASSISTANT_SKILL_META_NAMESPACE]);
  return meta.enabled === true;
}

/** One assistant-skill entry for the MCP-instructions / chat-context indexes. */
export interface AssistantSkillHint {
  /** Exact package id, e.g. "@appstrate/copilot" — load via `getSkill`. */
  package_id: string;
  display_name: string;
  /** When-to-use trigger — the only text the model sees before loading. */
  description: string;
}

/**
 * List the assistant skills known to this instance: system skills carrying the
 * explicit assistant marker. Reads the in-memory registry (loaded once at boot),
 * so it is synchronous and free — safe on the get_me / MCP-initialize hot
 * paths. Sorted by id for deterministic prompt output.
 */
export function listAssistantSkills(): AssistantSkillHint[] {
  return getSystemPackagesByType("skill")
    .filter((entry) => isAssistantSkill(entry.manifest))
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
    "Reusable instruction sets for recurring assistant situations. Choose the most specific " +
      "guide that clearly matches the current decision. Load one guide at a time, and load " +
      "another only when the first delegates that branch. If none clearly matches, load none. " +
      "Load the selected guide BEFORE " +
      'acting: call `invoke_operation` with `operation_id: "getSkill"` and `path_params: ' +
      '{ "scope": "<@scope>", "name": "<name>" }` (split the skill\'s `@scope/name` id, KEEP the ' +
      "leading `@` on the scope), then read the returned `content` and follow the guide. " +
      "Assistant skills guide the chat and are never dependencies to attach to an agent. " +
      "When a reusable method must belong to the organization, the loaded authoring guide " +
      "owns its creation or improvement.",
  ];
  for (const s of skills) {
    const label = s.display_name !== s.package_id ? `${s.display_name}: ` : "";
    lines.push(`- \`${s.package_id}\` — ${label}${s.description}`);
  }
  return lines.join("\n");
}

/**
 * The single `## Assistant skills` index, owned by the platform MCP server
 * instructions. It is injected BEFORE the operation index so it survives the chat's per-provider
 * index trim (`applyOperationIndexPolicy`). "" when no assistant skill is
 * loaded (e.g. a deployment that stripped them from `system-packages/`).
 */
export function buildAssistantSkillsSection(): string {
  return formatAssistantSkillsSection(listAssistantSkills());
}
