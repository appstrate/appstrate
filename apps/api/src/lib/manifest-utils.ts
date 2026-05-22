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
 * Extract skill IDs from a manifest's dependencies section.
 *
 * The platform's transitive dependency graph is skill-only: agents pull in
 * skills, and skills can depend on other skills. Integrations are resolved
 * through a separate path (`parseManifestIntegrations`), and the legacy
 * `tool`/`provider` package types are gone — so this returns a bare list of
 * skill package IDs rather than a typed multi-category bag.
 */
export function extractSkillIdsFromManifest(manifest: Partial<Manifest>): string[] {
  const dependencies = asRecord(manifest.dependencies);
  const skillsMap = asRecord(dependencies.skills) as Record<string, string>;
  return Object.keys(skillsMap).filter(Boolean);
}

/** Extract input/config/output JSON schemas from a manifest, with safe narrowing. */
export function extractManifestSchemas(manifest: Partial<Manifest>): {
  input?: JSONSchemaObject;
  config?: JSONSchemaObject;
  output?: JSONSchemaObject;
} {
  const m = manifest as Record<string, { schema?: unknown } | undefined>;
  return {
    input: m.input?.schema ? asJSONSchemaObject(m.input.schema) : undefined,
    config: m.config?.schema ? asJSONSchemaObject(m.config.schema) : undefined,
    output: m.output?.schema ? asJSONSchemaObject(m.output.schema) : undefined,
  };
}
