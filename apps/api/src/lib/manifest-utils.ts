/** Extract skill and extension IDs from a manifest's requires section. */
export function extractDepsFromManifest(manifest: Record<string, unknown>) {
  const requires = (manifest.requires ?? {}) as Record<string, unknown>;
  return {
    skillIds: (requires.skills as string[] | undefined)?.filter(Boolean) ?? [],
    extensionIds: (requires.extensions as string[] | undefined)?.filter(Boolean) ?? [],
  };
}
