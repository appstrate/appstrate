// SPDX-License-Identifier: Apache-2.0

export { toSlug } from "@appstrate/core/naming";

/**
 * Like {@link toSlug} but keeps trailing hyphens — use during typing, finalize
 * with `toSlug` on blur, so a user typing "my agent" is not fighting a slug
 * that eats the separator the moment they type it.
 */
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

/**
 * A list's search box: whether one of a row's texts holds `search`, ignoring
 * case and surrounding blanks. An empty search matches every row; a missing
 * text matches none.
 */
export function matchesSearch(
  search: string,
  texts: readonly (string | null | undefined | readonly string[])[],
): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return texts.flat().some((text) => text?.toLocaleLowerCase().includes(needle) ?? false);
}
