// SPDX-License-Identifier: Apache-2.0

export { toSlug } from "@appstrate/core/naming";

/** Like {@link toSlug} but keeps trailing hyphens: use while typing, finalize with `toSlug` on blur. */
export function toLiveSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "");
}

/** Whether two id lists hold the same ids, whatever their order. */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

/** A list's search box: case-insensitive, trimmed; an empty search matches every row, a missing text none. */
export function matchesSearch(
  search: string,
  texts: readonly (string | null | undefined | readonly string[])[],
): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return texts.flat().some((text) => text?.toLocaleLowerCase().includes(needle) ?? false);
}
