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

/** The signed-in person, as their own personal space shows them. */
export interface SpaceViewer {
  id: string;
  /** Display name, else email. */
  name: string;
}

/** What an `IdentityTile` draws: a space's, an organization's. */
export interface IdentityTileProps {
  icon: string | null;
  color: string | null;
  seed: string;
  label: string;
}

/**
 * How to DRAW a space: a team space by its own icon and colour; the viewer's own
 * personal space as the viewer (their initials on their colour — a personal space
 * takes no appearance of its own); an orphaned one, somebody else's, as a person
 * who is gone.
 */
export function spaceTile(
  space: {
    id: string;
    personal: boolean;
    name: string;
    icon: string | null;
    color: string | null;
    orphaned_at?: string | null;
  },
  viewer: SpaceViewer | null,
): IdentityTileProps {
  if (!space.personal) {
    return { icon: space.icon, color: space.color, seed: space.id, label: space.name };
  }
  if (space.orphaned_at) {
    return { icon: "lucide:user-x", color: null, seed: space.id, label: space.name };
  }
  if (!viewer) return { icon: "lucide:user", color: null, seed: space.id, label: space.name };
  return { icon: null, color: null, seed: viewer.id, label: viewer.name };
}
