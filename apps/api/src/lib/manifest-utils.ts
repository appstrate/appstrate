// SPDX-License-Identifier: Apache-2.0

import type { Manifest } from "@appstrate/core/validation";
import { asRecord } from "@appstrate/core/safe-json";
import { asJSONSchemaObject } from "@appstrate/core/form";
import type { JSONSchemaObject } from "@appstrate/core/form";

/** Narrow a JSONB-stored manifest column (`unknown`) to the typed shape. */
export function parseDraftManifest(value: unknown): Partial<Manifest> {
  return asRecord(value) as Partial<Manifest>;
}

/**
 * Identify the manifest-text value used when an optional companion is absent.
 * Only apply this shape heuristic to optional content: required primary files
 * may legitimately contain JSON. A template-only companion also matches, so
 * callers must retain its archive bytes and file operations remain authoritative.
 */
export function isManifestTextFallback(content: string | null | undefined): boolean {
  if (!content) return false;
  return content.trimStart().startsWith("{") && content.trimEnd().endsWith("}");
}

/**
 * Extract skill IDs from a manifest's dependencies section.
 *
 * The platform's transitive dependency graph is skill-only: agents pull in
 * skills, and skills can depend on other skills. Integrations are resolved
 * through a separate path (`parseManifestIntegrations`), so this returns a
 * bare list of skill package IDs rather than a typed multi-category bag.
 */
export function extractSkillIdsFromManifest(manifest: Partial<Manifest>): string[] {
  const dependencies = asRecord(manifest.dependencies);
  const skillsMap = asRecord(dependencies.skills) as Record<string, string>;
  return Object.keys(skillsMap).filter(Boolean);
}

/**
 * Extract a manifest's output JSON schema, with safe narrowing.
 *
 * Output only. This returned `{ input, output }` until the input half ran out
 * of readers: every input-schema caller reaches `manifest.input?.schema` at its
 * own site (`routes/runs.ts`, `routes/schedules.ts`, `services/inline-run.ts`, …).
 */
export function extractManifestOutputSchema(
  manifest: Partial<Manifest>,
): JSONSchemaObject | undefined {
  const m = manifest as Record<string, { schema?: unknown } | undefined>;
  return m.output?.schema ? asJSONSchemaObject(m.output.schema) : undefined;
}
