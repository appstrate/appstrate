import type { Manifest } from "@appstrate/core/validation";
import type { FlowProviderRequirement } from "../types/index.ts";

/** Extract skill, tool, and provider IDs from a manifest's dependencies section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const dependencies = (manifest.dependencies ?? {}) as Record<string, unknown>;
  const skillsMap = (dependencies.skills ?? {}) as Record<string, string>;
  const toolsMap = (dependencies.tools ?? {}) as Record<string, string>;
  const providersMap = (dependencies.providers ?? {}) as Record<string, string>;
  return {
    skillIds: Object.keys(skillsMap).filter(Boolean),
    toolIds: Object.keys(toolsMap).filter(Boolean),
    providerIds: Object.keys(providersMap).filter(Boolean),
  };
}

/** Merge dependencies.providers + providersConfiguration into FlowProviderRequirement[]. */
export function resolveManifestProviders(manifest: Partial<Manifest>): FlowProviderRequirement[] {
  const dependencies = (manifest.dependencies ?? {}) as Record<string, unknown>;
  const providersRecord = (dependencies.providers ?? {}) as Record<string, string>;
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
