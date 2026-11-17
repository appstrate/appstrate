// SPDX-License-Identifier: Apache-2.0

/**
 * Acting from « Tous les espaces », where the screen is the same as in a space and an action that
 * needs a space gets one:
 *
 * - on a ROW, in the row's space: the action names that space itself (an explicit `X-Space-Id`),
 *   or is a `useSpaceAction` among the row's spaces when it continues there (`RunAgentButton`),
 *   in the working space when it is one of them;
 * - naming NO space (create, import, the chat): `useSpaceAction` offers it where some space
 *   grants it; between several its own trigger is a menu of them (`choose`, drawn by
 *   `SpaceChoiceDropdown` or a menu entry's sub-menu), the only one is taken without asking. It
 *   enters the space chosen as the working space, then continues the action, which therefore
 *   renders and requests in that space (its dialog names it, `Modal`'s `inSpace`). Out of the
 *   mode it is the working space's action, unchanged.
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
 * when given, and `offered` when there is one.
 */
export function useSpacesFor(need: SpaceNeed, among?: readonly string[]) {
  const { on } = useOverviewMode();
  const { can } = usePermissions();
  const canReach = useCanReach();
  const { features } = useAppConfig();
  const orgPermissions = useOrg().currentOrg?.permissions;
  const { data: spaces } = useSpaces();

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
  return { on, eligible, offered };
}

/**
 * An action naming no space. `offered`: whether to show it at all. `run(act)`: performs `act` in
 * the space that grants `need`, among `among` when given (out of the mode, the working space);
 * between several it does nothing, the reader choosing in `choose(label, act)`, the menu its
 * trigger becomes — `undefined` when there is nothing to choose. `link(to)`: a link going to `to`
 * the same way.
 */
export function useSpaceAction(need: SpaceNeed, among?: readonly string[]) {
  const { on, eligible, offered } = useSpacesFor(need, among);
  const actIn = useActInSpace();
  const navigate = useNavigate();
  const workingSpaceId = useCurrentSpaceId();
  // A row's action continues in the working space when it is among the row's.
  const choice = on ? spaceChoice(eligible, among ? workingSpaceId : null) : null;

  const run = (act: () => void) => {
    if (!choice) return act();
    if (choice.kind === "one") actIn(choice.spaceId, act);
  };

  return {
    offered,
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
