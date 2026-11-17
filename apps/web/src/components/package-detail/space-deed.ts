// SPDX-License-Identifier: Apache-2.0

/**
 * A deed of the package Actions menu that acts in one space. With a working space it acts there;
 * in « Tous les espaces » it asks which space: one possible space is one click, several open the
 * menu of them (`SpaceChoiceSubmenu`), none hides the entry.
 */

import type { SpaceChoiceMenu } from "../../lib/menu-action";

type ChoiceSpace = SpaceChoiceMenu["spaces"][number];

export interface SpaceDeed {
  /** Whether the entry shows at all. */
  offered: boolean;
  /** The deed, its space known (the working one, or the only one). */
  onSelect?: () => void;
  /** The spaces to choose among: the entry opens their menu instead of acting. */
  inSpaces?: SpaceChoiceMenu;
  /** Replaces the entry's own label: it names the one space it acts in. */
  label?: string;
  /** Shown, not available now (an act already in flight, runs still going). */
  disabled?: boolean;
}

/** `useSpaceAction`'s verdict as a deed: `act` performed in the space the action enters. */
export function deedOfAction(
  action: {
    offered: boolean;
    run: (act: () => void) => void;
    choose: (label: string, act: () => void) => SpaceChoiceMenu | undefined;
  },
  menuLabel: string,
  act: () => void,
): SpaceDeed {
  return {
    offered: action.offered,
    onSelect: () => action.run(act),
    inSpaces: action.choose(menuLabel, act),
  };
}

/**
 * A deed acting on a named space without entering it, among `spaces`: one click naming it
 * (`labels.one`) with one, the menu of them under `labels.menu` with several.
 */
export function deedInSpaces(
  spaces: readonly ChoiceSpace[],
  labels: { menu: string; one: (space: ChoiceSpace) => string },
  act: (spaceId: string) => void,
): SpaceDeed {
  const [only] = spaces;
  if (!only) return { offered: false };
  if (spaces.length === 1) {
    return { offered: true, label: labels.one(only), onSelect: () => act(only.id) };
  }
  return {
    offered: true,
    label: labels.menu,
    inSpaces: { label: labels.menu, spaces, onPick: act },
  };
}
