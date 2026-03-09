import type { Manifest } from "@appstrate/core/validation";
import type { FlowProviderRequirement } from "../types/index.ts";

/** Extract skill, extension, and provider IDs from a manifest's requires section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const skillsMap = (requires.skills ?? {}) as Record<string, string>;
  const extensionsMap = (requires.extensions ?? {}) as Record<string, string>;
  const providersMap = (requires.providers ?? {}) as Record<string, string>;
  return {
    skillIds: Object.keys(skillsMap).filter(Boolean),
    extensionIds: Object.keys(extensionsMap).filter(Boolean),
    providerIds: Object.keys(providersMap).filter(Boolean),
  };
}

/** Merge requires.providers + providersConfiguration into FlowProviderRequirement[]. */
export function resolveManifestProviders(manifest: Partial<Manifest>): FlowProviderRequirement[] {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const providersRecord = (requires.providers ?? {}) as Record<string, string>;
  const config = ((manifest as Record<string, unknown>).providersConfiguration ?? {}) as Record<
    string,
    { scopes?: string[]; connectionMode?: "user" | "admin" }
  >;

  return Object.entries(providersRecord).map(([providerId, _version]) => ({
    id: providerId,
    provider: providerId,
    scopes: config[providerId]?.scopes,
    connectionMode: config[providerId]?.connectionMode,
  }));
}
