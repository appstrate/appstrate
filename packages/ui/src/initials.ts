// SPDX-License-Identifier: Apache-2.0

/**
 * Avatar initials: the first letters of the first and the last word of `label`
 * (« Organisation de Pierre Test » → « OT » — the words between are mostly
 * function words), `?` when it has none. A single word gives its one letter.
 */
export function initials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = [first, last].map((word) => (word ? Array.from(word)[0] : "")).join("");
  return letters ? letters.toUpperCase() : "?";
}
