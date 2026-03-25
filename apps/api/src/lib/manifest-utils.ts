import type { Manifest } from "@appstrate/core/validation";
import type { FlowProviderRequirement } from "../types/index.ts";
import { asRecord } from "./safe-json.ts";

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

/** Merge dependencies.providers + providersConfiguration into FlowProviderRequirement[]. */
export function resolveManifestProviders(manifest: Partial<Manifest>): FlowProviderRequirement[] {
  const dependencies = asRecord(manifest.dependencies);
  const providersRecord = asRecord(dependencies.providers) as Record<string, string>;
  const config = asRecord((manifest as Record<string, unknown>).providersConfiguration) as Record<
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
