// SPDX-License-Identifier: Apache-2.0

import type { BreadcrumbEntry } from "@/stores/breadcrumb-store";

/** The conversation's name: the list's row when it holds it, else the conversation's own; null when neither does. */
export function resolveCrumbTitle(
  listed: { title?: string | null } | undefined,
  detail: { title?: string | null } | undefined,
  untitled: string,
): string | null {
  const known = listed ?? detail;
  return known ? (known.title ?? untitled) : null;
}

/**
 * The chat's trail: "Chat" alone, a slot while the name loads, else "Chat / <name>" followed by a
 * slot for the touched spaces when there are some (a conversation that touched none stays quiet).
 */
export function chatTrailEntries(
  chat: string,
  title: string | null,
  loading: boolean,
  touchedCount: number,
): BreadcrumbEntry[] {
  if (title !== null) {
    return [
      { label: chat, href: "/chat" },
      { label: title },
      ...(touchedCount > 0 ? [{ label: "", slot: true as const }] : []),
    ];
  }
  return loading
    ? [
        { label: chat, href: "/chat" },
        { label: "", slot: true },
      ]
    : [{ label: chat }];
}
