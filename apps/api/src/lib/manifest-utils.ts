import type { Manifest } from "@appstrate/core/validation";
import type { FlowServiceRequirement } from "../types/index.ts";

/** Extract skill, extension, and provider IDs from a manifest's requires section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const skillsMap = (requires.skills ?? {}) as Record<string, string>;
  const extensionsMap = (requires.extensions ?? {}) as Record<string, string>;
  const servicesMap = (requires.services ?? {}) as Record<string, string>;
  return {
    skillIds: Object.keys(skillsMap).filter(Boolean),
    extensionIds: Object.keys(extensionsMap).filter(Boolean),
    providerIds: Object.keys(servicesMap).filter(Boolean),
  };
}

/** Merge requires.services + servicesConfiguration into FlowServiceRequirement[]. */
export function resolveManifestServices(manifest: Partial<Manifest>): FlowServiceRequirement[] {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const servicesRecord = (requires.services ?? {}) as Record<string, string>;
  const config = ((manifest as Record<string, unknown>).servicesConfiguration ?? {}) as Record<
    string,
    { scopes?: string[]; connectionMode?: "user" | "admin" }
  >;

  return Object.entries(servicesRecord).map(([providerId, _version]) => ({
    id: providerId,
    provider: providerId,
    scopes: config[providerId]?.scopes,
    connectionMode: config[providerId]?.connectionMode,
  }));
}
