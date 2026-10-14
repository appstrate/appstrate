// SPDX-License-Identifier: Apache-2.0

/** A LIKE pattern matching `text` anywhere, its `%`, `_` and `\` taken as typed. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}
