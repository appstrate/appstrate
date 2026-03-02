import type { Manifest } from "@appstrate/validation";

/** Extract skill and extension IDs from a manifest's requires section. */
export function extractDepsFromManifest(manifest: Partial<Manifest>) {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  return {
    skillIds: (requires.skills as string[] | undefined)?.filter(Boolean) ?? [],
    extensionIds: (requires.extensions as string[] | undefined)?.filter(Boolean) ?? [],
  };
}
