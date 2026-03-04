import type { Manifest } from "@appstrate/core/validation";

/** Extract skill and extension IDs from a manifest's requires section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  const skillsMap = (requires.skills ?? {}) as Record<string, string>;
  const extensionsMap = (requires.extensions ?? {}) as Record<string, string>;
  return {
    skillIds: Object.keys(skillsMap).filter(Boolean),
    extensionIds: Object.keys(extensionsMap).filter(Boolean),
  };
}
