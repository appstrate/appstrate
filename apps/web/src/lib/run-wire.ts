// SPDX-License-Identifier: Apache-2.0

import type { ResolvedSkillVersionMap } from "@appstrate/shared-types";

type WireResolvedSkillVersion =
  { source: "version"; version: string } | { source: "draft"; version?: null };

type RunWithWireResolvedSkills = {
  resolved_skill_versions: Record<string, WireResolvedSkillVersion> | null;
};

/**
 * Restore the explicit `version: null` discriminator on draft skill selections.
 *
 * `openapi-fetch` applies its `Readable<T>` helper to response bodies. That
 * helper currently drops properties whose only possible value is `null`, so a
 * schema-required `version: null` reaches TypeScript as an omitted property.
 * The JSON response still carries the field. Normalizing at the client boundary
 * keeps the application-facing run type strict and also repairs legacy payloads.
 */
export function normalizeRunResolvedSkillVersions<T extends RunWithWireResolvedSkills>(
  run: T,
): Omit<T, "resolved_skill_versions"> & {
  resolved_skill_versions: ResolvedSkillVersionMap | null;
} {
  const normalized = run.resolved_skill_versions
    ? Object.fromEntries(
        Object.entries(run.resolved_skill_versions).map(([packageId, selection]) => [
          packageId,
          selection.source === "draft"
            ? { source: "draft" as const, version: null }
            : { source: "version" as const, version: selection.version },
        ]),
      )
    : null;

  return { ...run, resolved_skill_versions: normalized };
}
