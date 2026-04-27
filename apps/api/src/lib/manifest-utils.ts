// SPDX-License-Identifier: Apache-2.0

import type { Manifest } from "@appstrate/core/validation";
import type { AgentProviderRequirement } from "../types/index.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { asJSONSchemaObject } from "@appstrate/core/form";
import type { JSONSchemaObject } from "@appstrate/core/form";
import { parseManifestProviders } from "@appstrate/core/dependencies";

/** Narrow a JSONB-stored manifest column (`unknown`) to the typed shape. */
export function parseDraftManifest(value: unknown): Partial<Manifest> {
  return asRecord(value) as Partial<Manifest>;
}

/** Extract skill, tool, and provider IDs from a manifest's dependencies section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const dependencies = asRecord(manifest.dependencies);
  const skillsMap = asRecord(dependencies.skills) as Record<string, string>;
  const toolsMap = asRecord(dependencies.tools) as Record<string, string>;
  const providersMap = asRecord(dependencies.providers) as Record<string, string>;
  return {
    skillIds: Object.keys(skillsMap).filter(Boolean),
    toolIds: Object.keys(toolsMap).filter(Boolean),
    providerIds: Object.keys(providersMap).filter(Boolean),
  };
}

/** Merge dependencies.providers + providersConfiguration into AgentProviderRequirement[]. */
export function resolveManifestProviders(manifest: Partial<Manifest>): AgentProviderRequirement[] {
  return parseManifestProviders(manifest as Record<string, unknown>).map(({ id, scopes }) => ({
    id,
    scopes: scopes.length > 0 ? scopes : undefined,
  }));
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
