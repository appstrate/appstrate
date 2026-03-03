export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a marketplace path from the package ID (@scope/name format).
 * Returns `/marketplace/@scope/name` or null if not resolvable.
 */
export function marketplacePath(detail: { id?: string }): string | null {
  if (!detail.id) return null;
  const match = detail.id.match(/^@([^/]+)\/(.+)$/);
  if (!match) return null;
  return `/marketplace/@${match[1]}/${match[2]}`;
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
