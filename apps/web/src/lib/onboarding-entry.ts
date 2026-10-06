// SPDX-License-Identifier: Apache-2.0

/** Where a user with no organization lands: the form `POST /api/orgs` would accept, else the waiting page. */
export function orgLessEntry(canCreateOrg: boolean): "/onboarding/create" | "/onboarding/waiting" {
  return canCreateOrg ? "/onboarding/create" : "/onboarding/waiting";
}

/** Where the waiting page sends a user who is not waiting; `null` when they are. */
export function waitingStepRedirect(state: {
  canCreateOrg: boolean;
  hasOrg: boolean;
}): "/" | "/onboarding/create" | null {
  if (state.hasOrg) return "/";
  const entry = orgLessEntry(state.canCreateOrg);
  return entry === "/onboarding/waiting" ? null : entry;
}

/**
 * Where the creation form sends a user who may not use it; `null` leaves the
 * page in charge (with an organization it is a step of that org's onboarding).
 */
export function createStepRedirect(state: {
  canCreateOrg: boolean;
  hasOrg: boolean;
  fromSwitcher: boolean;
}): "/onboarding/waiting" | "/onboarding/create" | "/" | null {
  if (state.canCreateOrg) return null;
  if (!state.hasOrg) return orgLessEntry(false);
  return state.fromSwitcher ? "/" : null;
}
