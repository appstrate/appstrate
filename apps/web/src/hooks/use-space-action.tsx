// SPDX-License-Identifier: Apache-2.0

/**
 * Acting from « Vue d'ensemble », where the screen is the same as in a space and an action that
 * needs a space gets one:
 *
 * - on a ROW, in the row's space: the action names that space itself (an explicit `X-Space-Id`),
 *   or is a `useSpaceAction` among the row's spaces when it continues there (`RunAgentButton`);
 * - naming NO space (create, import, the catalogue, the chat): `useSpaceAction` offers it where
 *   some space grants it, asks « Dans quel espace ? » between several (the only one is taken
 *   without asking), enters the space picked as the working space, then continues the action,
 *   which therefore renders and requests in that space. Out of the mode it is the working
 *   space's action, unchanged.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SpacePickerModal } from "../components/space-picker-modal";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { spaceChoice, spacesWhere, type SpaceGate } from "../lib/space-lists";
import { useAppConfig } from "./use-app-config";
import { useCanReach } from "./use-can-reach";
import { useSpaceSwitcher } from "./use-current-space";
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
 * `act` sends, and every screen it opens, is that space's.
 */
function useActInSpace(): (spaceId: string, act: () => void) => void {
  const { switchSpace } = useSpaceSwitcher();
  return useCallback(
    (spaceId, act) => {
      if (spaceId === spaceStore.getState().id) return act();
      requestScopeChange(() => {
        switchSpace(spaceId);
        act();
      });
    },
    [switchSpace],
  );
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
 * a space that grants `need`, among `among` when given (out of the mode, the working space).
 * `link(to)`: a link going to `to` the same way. `picker`: render it, it is the question when one
 * is asked.
 */
export function useSpaceAction(need: SpaceNeed, among?: readonly string[]) {
  const { on, eligible, offered } = useSpacesFor(need, among);
  const actIn = useActInSpace();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<{ act: () => void } | null>(null);

  const run = (act: () => void) => {
    if (!on) return act();
    const choice = spaceChoice(eligible);
    if (choice.kind === "one") {
      actIn(choice.spaceId, act);
    } else if (choice.kind === "ask") {
      setAsking({ act });
    }
  };

  const picker = asking && (
    <SpacePickerModal
      spaces={eligible}
      onPick={(spaceId) => {
        setAsking(null);
        actIn(spaceId, asking.act);
      }}
      onClose={() => setAsking(null)}
    />
  );

  return {
    offered,
    run,
    /** A link to `to`: plain out of the mode; in it, `onSelect` replaces the navigation with `run`. */
    link: (to: string): { to: string; onSelect?: () => void } => ({
      to,
      onSelect: on ? () => run(() => navigate(to)) : undefined,
    }),
    picker,
  };
}
