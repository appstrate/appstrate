// SPDX-License-Identifier: Apache-2.0

/**
 * Acting from « Vue d'ensemble », where the screen is the same as in a space and an action that
 * needs a space gets one:
 *
 * - on a ROW, in the row's space: `useRowSpaceGrants` says whether the row's space grants the
 *   action, and the action names that space itself (an explicit `X-Space-Id`, or the row's space
 *   entered as the working space when the action continues there, `RunAgentButton`);
 * - naming NO space (create, import, the catalogue): `useSpaceAction` offers it where
 *   some space grants it, asks « Dans quel espace ? » between several (the only one is taken
 *   without asking), enters the space picked as the working space, then continues the action,
 *   which therefore renders and requests in that space. Out of the mode it is the working
 *   space's action, unchanged.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SpacePickerModal } from "../components/space-picker-modal";
import { routeVerdict, type RoutePath } from "../lib/route-access";
import { grantsInRowSpace, spaceChoice, spacesWhere, type SpaceGate } from "../lib/space-lists";
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

/** Whether `permission` holds in a row's space (`spaceId`; the working space's when absent). */
export function useRowSpaceGrants(): (spaceId: string | undefined, permission: string) => boolean {
  const { can } = usePermissions();
  const workingSpaceId = useCurrentSpaceId();
  const { data: spaces } = useSpaces();
  const orgPermissions = useOrg().currentOrg?.permissions;
  return useCallback(
    (spaceId, permission) =>
      grantsInRowSpace(spaceId, workingSpaceId, can, spaces, orgPermissions, permission),
    [can, workingSpaceId, spaces, orgPermissions],
  );
}

/**
 * Performs `act` in `spaceId`: at once in the working space, else after entering it as the
 * working space (behind the unsaved-drafts question a scope change asks), so every request
 * `act` sends, and every screen it opens, is that space's.
 */
export function useActInSpace(): (spaceId: string, act: () => void) => void {
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
 * verdict and `eligible` is empty. In it: the spaces that grant `need`, and `offered` when there
 * is one.
 */
export function useSpacesFor(need: SpaceNeed) {
  const { on } = useOverviewMode();
  const { can } = usePermissions();
  const canReach = useCanReach();
  const { features } = useAppConfig();
  const orgPermissions = useOrg().currentOrg?.permissions;
  const { data: spaces } = useSpaces();

  const admits = (gate: SpaceGate, space: { personal: boolean }) =>
    "permission" in need
      ? gate(need.permission)
      : routeVerdict(need.route, gate, features, space.personal) === "granted";
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
 * a space that grants `need` (out of the mode, the working space). `link(to)`: a menu entry
 * going to `to` the same way. `picker`: render it, it is the question when one is asked.
 */
export function useSpaceAction(need: SpaceNeed) {
  const { on, eligible, offered } = useSpacesFor(need);
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
    /** A menu entry to `to`: a plain link out of the mode, through `run` in it. */
    link: (to: string): { to: string } | { onSelect: () => void } =>
      on ? { onSelect: () => run(() => navigate(to)) } : { to },
    picker,
  };
}
