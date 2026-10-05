// SPDX-License-Identifier: Apache-2.0

/**
 * Where a signed-in user with no organization lands: the creation form when
 * `POST /api/orgs` would accept them (`can_create_org`), the "waiting for an
 * invitation" page otherwise. Read by the org gate and by both pages, so
 * neither can be reached by URL against the rule.
 */
export function orgLessEntry(canCreateOrg: boolean): "/onboarding/create" | "/onboarding/waiting" {
  return canCreateOrg ? "/onboarding/create" : "/onboarding/waiting";
}

/**
 * Where the waiting page sends a user it has nothing to tell, or `null` when
 * they are indeed waiting: a member of an organization is not waiting for an
 * invitation, and a user who may create one has a form to fill.
 */
export function waitingStepRedirect(state: {
  canCreateOrg: boolean;
  hasOrg: boolean;
}): "/" | "/onboarding/create" | null {
  if (state.hasOrg) return "/";
  return state.canCreateOrg ? "/onboarding/create" : null;
}

/**
 * Where the creation form sends a user it must not be shown to, or `null` when
 * the page stays in charge. A user who may not create is turned away only
 * where the form would be USED: without an organization, or asking for another
 * one from the switcher. With an organization and no such request the page is
 * a step of that organization's onboarding and moves on by itself — the
 * bootstrap owner of a closed instance is not a platform admin and still has
 * the model and member steps ahead.
 */
export function createStepRedirect(state: {
  canCreateOrg: boolean;
  hasOrg: boolean;
  fromSwitcher: boolean;
}): "/onboarding/waiting" | "/" | null {
  if (state.canCreateOrg) return null;
  if (!state.hasOrg) return "/onboarding/waiting";
  return state.fromSwitcher ? "/" : null;
}
