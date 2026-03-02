export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a marketplace path from registry scope/name fields.
 * Returns `/marketplace/@scope/name` or null if not resolvable.
 */
export function marketplacePath(detail: {
  registryScope?: string | null;
  registryName?: string | null;
}): string | null {
  const { registryScope, registryName } = detail;
  if (!registryScope || !registryName) return null;
  const normalizedScope = registryScope.startsWith("@") ? registryScope : `@${registryScope}`;
  return `/marketplace/${normalizedScope}/${registryName}`;
}

/** Like toSlug but keeps trailing hyphens — use during typing, finalize with toSlug on blur. */
export function toLiveSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "");
}
