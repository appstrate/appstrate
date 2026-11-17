// SPDX-License-Identifier: Apache-2.0

import type { BreadcrumbEntry } from "@/stores/breadcrumb-store";

/** The chat's trail: "Chat" alone, a slot while the name loads, else "Chat / <name>". */
export function chatTrailEntries(
  chat: string,
  title: string | null,
  loading: boolean,
): BreadcrumbEntry[] {
  if (title !== null) return [{ label: chat, href: "/chat" }, { label: title }];
  return loading
    ? [
        { label: chat, href: "/chat" },
        { label: "", slot: true },
      ]
    : [{ label: chat }];
}
