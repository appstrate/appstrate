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
