// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from "react";
import type { IdentityTile } from "@appstrate/ui/components/identity-tile";

/** What an `IdentityTile` draws: a space's, an organization's. */
export type IdentityTileProps = Pick<
  ComponentProps<typeof IdentityTile>,
  "icon" | "color" | "seed" | "label"
>;

/** The signed-in person, as their own personal space shows them. */
export interface SpaceViewer {
  id: string;
  /** Display name, else email. */
  name: string;
}

/** How to DRAW an organization: its own icon and colour, the colour derived from its id when none is chosen. */
export function orgTile(org: {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
}): IdentityTileProps {
  return { icon: org.icon, color: org.color, seed: org.id, label: org.name };
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
