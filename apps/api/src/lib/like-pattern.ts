// SPDX-License-Identifier: Apache-2.0

/** `%`, `_` and `\` taken as typed (Postgres' default LIKE escape is the backslash). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** A LIKE pattern matching `text` anywhere, its `%`, `_` and `\` taken as typed. */
export function likeContains(text: string): string {
  return `%${escapeLike(text)}%`;
}

/** A LIKE pattern matching what starts with `text`, its `%`, `_` and `\` taken as typed. */
export function likePrefix(text: string): string {
  return `${escapeLike(text)}%`;
}
