// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";

/**
 * What to CALL a space in the UI. A personal space's stored `name` is written once
 * by the server; the label is the reader's own translation, keyed off `personal`
 * (the wire never says whose space it is, RBAC spec §3.6). An ORPHANED one is
 * always somebody else's. The namespace is pinned: some callers only have
 * `settings` as a secondary namespace.
 */
export function spaceLabel(
  space: { personal: boolean; name: string; orphaned_at?: string | null },
  t: TFunction,
): string {
  if (!space.personal) return space.name;
  return t(space.orphaned_at ? "spaces.personal.orphanedName" : "spaces.personal.title", {
    ns: "settings",
  });
}
