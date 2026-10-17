// SPDX-License-Identifier: Apache-2.0

/** Avatar initials: the first letter of the first two words of the name, else of the email. */
export function initials(
  name: string | null | undefined,
  email: string | null | undefined,
): string {
  const label = name?.trim() || email?.trim() || "";
  const letters = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("");
  return letters ? letters.toUpperCase() : "?";
}
