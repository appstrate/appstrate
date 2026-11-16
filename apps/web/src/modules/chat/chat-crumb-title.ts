// SPDX-License-Identifier: Apache-2.0

/** The conversation's name: the list's row when it holds it, else the conversation's own; null when neither does. */
export function resolveCrumbTitle(
  listed: { title?: string | null } | undefined,
  detail: { title?: string | null } | undefined,
  untitled: string,
): string | null {
  const known = listed ?? detail;
  return known ? (known.title ?? untitled) : null;
}
