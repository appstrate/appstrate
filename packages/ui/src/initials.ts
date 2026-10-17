// SPDX-License-Identifier: Apache-2.0

/** Avatar initials: the first letter of the first two words of `label`, `?` when it has none. */
export function initials(label: string): string {
  const letters = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("");
  return letters ? letters.toUpperCase() : "?";
}
