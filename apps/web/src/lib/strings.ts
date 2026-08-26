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
