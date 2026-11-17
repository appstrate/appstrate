// SPDX-License-Identifier: Apache-2.0

/**
 * Acting from « Tous les espaces »: a row's action runs in the row's space; an action naming no
 * space is offered where some space grants it, picked from a menu between several, and enters the
 * chosen space before continuing. Out of the mode it is the working space's action, unchanged.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import type { SpaceChoiceMenu } from "../lib/menu-action";
import { spaceChoice, spacesWhere, type SpaceGate } from "../lib/space-lists";
import { useAppConfig } from "./use-app-config";
import { useCanReach } from "./use-can-reach";
import { useCurrentSpaceId, useSpaceSwitcher } from "./use-current-space";
import { requestScopeChange } from "./use-unsaved-changes";
import { spaceStore } from "../stores/space-store";
import { useOrg } from "./use-org";
import { useOverviewMode } from "./use-overview-mode";
import { usePermissions } from "./use-permissions";
import { useSpaces } from "./use-spaces";

/** What an action needs of a space: a permission, or a route that opens there. */
type SpaceNeed = { permission: string } | { route: RoutePath };

/**
 * Performs `act` in `spaceId`: at once in the working space, else after entering it as the
 * working space (behind the unsaved-drafts question a scope change asks), so every request
 * `act` sends, and every screen it opens, is that space's. Exported for its test.
 */
export function actInSpace(
  spaceId: string,
  act: () => void,
  switchSpace: (spaceId: string) => void,
): void {
  if (spaceId === spaceStore.getState().id) return act();
  requestScopeChange(() => {
    switchSpace(spaceId);
    act();
  });
}

function useActInSpace(): (spaceId: string, act: () => void) => void {
  const { switchSpace } = useSpaceSwitcher();
  return useCallback((spaceId, act) => actInSpace(spaceId, act, switchSpace), [switchSpace]);
}

/**
 * Where an action naming no space may act. Out of the mode: `offered` is the working space's
 * verdict and `eligible` is empty. In it: the spaces that grant `need`, only those of `among`
 * when given, `offered` when there is one, and `anyOf` the one an act answering the same from
 * any of them reads (the working space when it is one).
 */
export function useSpacesFor(need: SpaceNeed, among?: readonly string[]) {
  const { on } = useOverviewMode();
  const { can } = usePermissions();
  const canReach = useCanReach();
  const { features } = useAppConfig();
  const orgPermissions = useOrg().currentOrg?.permissions;
  const { data: spaces } = useSpaces();
  const workingSpaceId = useCurrentSpaceId();

  const admits = (gate: SpaceGate, space: { id: string; personal: boolean }) =>
    (!among || among.includes(space.id)) &&
    ("permission" in need
      ? gate(need.permission)
      : routeVerdict(need.route, gate, features, space.personal) === "granted");
  const eligible = on ? spacesWhere(spaces, orgPermissions, admits) : [];
  const offered = on
    ? eligible.length > 0
    : "permission" in need
      ? can(need.permission)
      : canReach(need.route);
  const anyOf = (eligible.find((space) => space.id === workingSpaceId) ?? eligible[0])?.id;
  const working = spaces?.find((space) => space.id === workingSpaceId);
  const targets = on ? eligible : offered && working ? [working] : [];
  return { on, eligible, offered, anyOf, targets };
}

/** How {@link useSpaceAction} picks and enters a space. */
interface SpaceActionOptions {
  /**
   * Whether the working space is taken without asking when it is among `among` — a row's action
   * continues there. `false` on a page whose working space it does not name: the reader chooses.
   * Defaults to whether `among` is given.
   */
  preferWorkingSpace?: boolean;
  /**
   * Reads, before entering a space other than the working one, what the screen the switch redraws
   * shows, and resolves to `act` holding it: that is what runs once the space is entered, and
   * nothing runs when the read fails (it reports itself) or the switch is cancelled.
   */
  prepare?: (spaceId: string, act: () => void) => Promise<() => void>;
}

/**
 * An action naming no space. `offered`: whether to show it at all. `run(act)`: performs `act` in
 * the space that grants `need`, among `among` when given (out of the mode, the working space);
 * between several it does nothing, the reader choosing in `choose(label, act)`, the menu its
 * trigger becomes — `undefined` when there is nothing to choose. `target`: in the mode, the one
 * space `run` acts in without asking. `link(to)`: a link going to `to` the same way.
 */
export function useSpaceAction(
  need: SpaceNeed,
  among?: readonly string[],
  { preferWorkingSpace = among !== undefined, prepare }: SpaceActionOptions = {},
) {
  const { on, eligible, offered } = useSpacesFor(need, among);
  const actInSpace = useActInSpace();
  const navigate = useNavigate();
  const workingSpaceId = useCurrentSpaceId();
  const choice = on ? spaceChoice(eligible, preferWorkingSpace ? workingSpaceId : null) : null;
  const target =
    choice?.kind === "one" ? eligible.find((space) => space.id === choice.spaceId) : undefined;

  const actIn = (spaceId: string, act: () => void) => {
    if (!prepare || spaceId === spaceStore.getState().id) return actInSpace(spaceId, act);
    prepare(spaceId, act).then(
      (prepared) => actInSpace(spaceId, prepared),
      () => undefined,
    );
  };

  const run = (act: () => void) => {
    if (!choice) return act();
    if (choice.kind === "one") actIn(choice.spaceId, act);
  };

  return {
    on,
    offered,
    target,
    run,
    /** The menu of the spaces to act in, labelled `label` (« Créer dans… »); `undefined` unless the reader must choose. */
    choose: (label: string, act: () => void): SpaceChoiceMenu | undefined =>
      choice?.kind === "ask"
        ? { label, spaces: eligible, onPick: (spaceId) => actIn(spaceId, act) }
        : undefined,
    /** A link to `to`: plain out of the mode; in it, `onSelect` replaces the navigation with `run`. */
    link: (to: string): { to: string; onSelect?: () => void } => ({
      to,
      onSelect: on ? () => run(() => navigate(to)) : undefined,
    }),
  };
}
