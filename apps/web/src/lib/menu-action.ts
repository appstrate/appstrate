// SPDX-License-Identifier: Apache-2.0

import type { To } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import type { spaceTile } from "./identity-tile-props";

/**
 * The spaces an action naming no space may act in, when the reader chooses (`useSpaceAction`'s
 * `choose`): its trigger opens a menu of them under `label` (« Créer dans… »).
 */
export interface SpaceChoiceMenu {
  label: string;
  spaces: readonly Parameters<typeof spaceTile>[0][];
  onPick: (spaceId: string) => void;
}

/**
 * One deed of a menu, declared once whichever menu draws it. `onSelect` acts in
 * place, `to` goes to an app route (`onSelect` replacing the navigation when both
 * are given), `href` opens an external page in a new tab.
 */
export interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect?: () => void;
  to?: To;
  href?: string;
  disabled?: boolean;
  /** Destroys or revokes: drawn last, behind a separator, in the destructive tone. */
  destructive?: boolean;
  hidden?: boolean;
  testId?: string;
  /** The reader chooses the space first: the entry opens a menu of them instead of acting. */
  inSpaces?: SpaceChoiceMenu;
}

/** A link's `onClick` when `onSelect` replaces its navigation; none without `onSelect`. */
export function replacingNavigation(
  onSelect: (() => void) | undefined,
): ((event: { preventDefault(): void }) => void) | undefined {
  return (
    onSelect &&
    ((event) => {
      event.preventDefault();
      onSelect();
    })
  );
}

/** The visible deeds, the destructive ones apart: a menu draws them last, behind a separator. */
export function splitMenuActions(actions: readonly MenuAction[]): {
  plain: MenuAction[];
  destructive: MenuAction[];
} {
  const visible = actions.filter((action) => !action.hidden);
  return {
    plain: visible.filter((action) => !action.destructive),
    destructive: visible.filter((action) => action.destructive),
  };
}
