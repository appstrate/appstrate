// SPDX-License-Identifier: Apache-2.0

/**
 * A deed that acts in one space (an Actions menu entry, a page button). With a space selected it
 * acts there under its own label. In « Tous les espaces » it asks which space: one possible space
 * is one click labelled « X dans {space} », several open the menu of them (`SpaceChoiceSubmenu`,
 * `SpaceChoiceDropdown`) labelled « X dans… », none hides it.
 */

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MenuAction, SpaceChoiceMenu } from "../lib/menu-action";
import { spaceLabel } from "../lib/space-label";
import { usePackageActivationInSpaces } from "../hooks/use-library";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { useSpacesOf } from "../hooks/use-spaces";

type ChoiceSpace = SpaceChoiceMenu["spaces"][number];

/** How a deed names its space in the mode: `menu` (« X dans… ») and `one(space)` (« X dans {space} »). */
export interface SpaceDeedLabels {
  menu: string;
  one: (space: ChoiceSpace) => string;
}

/** The labels of `menuKey` (« X dans… ») and `oneKey` (« X dans {{space}} »), both in `common`. */
export function spaceDeedLabels(t: TFunction, menuKey: string, oneKey: string): SpaceDeedLabels {
  return {
    menu: t(menuKey, { ns: "common" }),
    one: (space) => t(oneKey, { ns: "common", space: spaceLabel(space, t) }),
  };
}

export interface SpaceDeed {
  /** Whether the entry shows at all. */
  offered: boolean;
  /** The deed, its space known (the working one, or the only one). */
  onSelect?: () => void;
  /** The spaces to choose among: the entry opens their menu instead of acting. */
  inSpaces?: SpaceChoiceMenu;
  /** In the mode, replaces the entry's own label: it names its space, or asks it. */
  label?: string;
  /** Shown, not available now (an act already in flight, runs still going). */
  disabled?: boolean;
}

/** `useSpaceAction`'s verdict as a deed: `act` performed in the space the action enters. */
export function deedOfAction(
  action: {
    on: boolean;
    offered: boolean;
    target?: ChoiceSpace;
    run: (act: () => void) => void;
    choose: (label: string, act: () => void) => SpaceChoiceMenu | undefined;
  },
  labels: SpaceDeedLabels,
  act: () => void,
): SpaceDeed {
  const inSpaces = action.choose(labels.menu, act);
  return {
    offered: action.offered,
    onSelect: () => action.run(act),
    inSpaces,
    label: !action.on
      ? undefined
      : inSpaces
        ? labels.menu
        : action.target
          ? labels.one(action.target)
          : undefined,
  };
}

/**
 * A deed acting on a named space without entering it, among `spaces`: with a space selected
 * (`on` false) the working space, the one `spaces` holds then; in the mode one click naming it, or
 * the menu of them with several.
 */
export function deedInSpaces(
  on: boolean,
  spaces: readonly ChoiceSpace[],
  labels: SpaceDeedLabels,
  act: (spaceId: string) => void,
): SpaceDeed {
  const [only] = spaces;
  if (!only) return { offered: false };
  if (spaces.length === 1) {
    return {
      offered: true,
      label: on ? labels.one(only) : undefined,
      onSelect: () => act(only.id),
    };
  }
  return {
    offered: true,
    label: labels.menu,
    inSpaces: { label: labels.menu, spaces, onPick: act },
  };
}

/** The fields of a menu entry its deed decides; `label` only when the deed names or asks its space. */
export function deedEntry(
  deed: SpaceDeed | undefined,
): Pick<MenuAction, "hidden" | "disabled" | "onSelect" | "inSpaces"> & { label?: string } {
  return {
    hidden: !deed?.offered,
    disabled: deed?.disabled,
    onSelect: deed?.onSelect,
    inSpaces: deed?.inSpaces,
    ...(deed?.label ? { label: deed.label } : {}),
  };
}

/**
 * A package's placement deeds, the one way « Activer », « Désactiver » and « Retirer de » act
 * (`usePackageActivationInSpaces` + {@link deedInSpaces}): with a space selected, in it; in
 * « Tous les espaces », in the spaces the organization library lets the reader act in.
 * `activate` switches the package on at once; `deactivate` and `remove` hand their space to the
 * caller's confirmation (`onDeactivate`, `onRemove`), and are not offered without one. `pending`
 * while a switch is in flight; `setActive` performs one, for that confirmation.
 */
export function usePlacementDeeds(
  packageId: string,
  {
    onDeactivate,
    onRemove,
  }: { onDeactivate?: (spaceId: string) => void; onRemove?: (spaceId: string) => void } = {},
) {
  const { t } = useTranslation(["common", "settings"]);
  const { on } = useOverviewMode();
  const placement = usePackageActivationInSpaces(packageId, { spanning: on });
  const deed = (
    spaces: readonly ChoiceSpace[],
    keys: [string, string],
    act: ((spaceId: string) => void) | undefined,
  ): SpaceDeed =>
    act
      ? {
          ...deedInSpaces(on, spaces, spaceDeedLabels(t, ...keys), act),
          disabled: placement.pending,
        }
      : { offered: false };
  const activateIn = useSpacesOf(placement.activateIn);
  const deactivateIn = useSpacesOf(placement.deactivateIn);
  const removeFrom = useSpacesOf(placement.removeFrom);
  return {
    activate: deed(activateIn, ["spaceChoice.activate", "spaceChoice.activateIn"], (id) =>
      placement.setActive(id, true),
    ),
    deactivate: deed(
      deactivateIn,
      ["spaceChoice.deactivate", "spaceChoice.deactivateIn"],
      onDeactivate,
    ),
    remove: deed(removeFrom, ["spaceChoice.remove", "spaceChoice.removeIn"], onRemove),
    setActive: placement.setActive,
    pending: placement.pending,
  };
}
