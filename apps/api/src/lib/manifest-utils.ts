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
 * Whether a `packages.draft_content` value is the MANIFEST-TEXT FALLBACK rather
 * than the package type's own content file.
 *
 * The column is populated from `PACKAGE_CONTENT_ENTRY`
 * (`@appstrate/core/package-files`), whose `integration` entry is OPTIONAL:
 * `parsePackageZip` stores the bundle's `INTEGRATION.md` when it ships one and
 * the MANIFEST TEXT when it does not, with nothing on the row saying which. So
 * every reader that wants the real companion doc — the platform prompt's
 * integration docs, the file explorer's draft overlay — has to tell the two
 * apart, and every writer that produces a manifest copy has to avoid
 * overwriting a row that holds the real thing. One predicate, so those four
 * decisions cannot disagree about what the column contains.
 *
 * The test is deliberately shape-based: the fallback is a serialized JSON
 * object and an `INTEGRATION.md` is markdown, so "starts with `{` and ends with
 * `}`" separates them without parsing a document that may be tens of KB.
 *
 * Only ever apply it to a type whose content entry is OPTIONAL. A `prompt.md` /
 * `SKILL.md` is REQUIRED and therefore has no fallback to be confused with —
 * sniffing one would let a JSON-shaped prompt be mistaken for a manifest.
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
