// SPDX-License-Identifier: Apache-2.0

import type { OrgRole } from "@appstrate/shared-types";
import { ORG_ROLES_WITH_FULL_ACCESS } from "@appstrate/core/permissions";

/** An org owner or admin: the role the server's role-keyed rules (preview, governance) check. */
export function hasFullOrgAccess(orgRole: OrgRole | null): boolean {
  return orgRole !== null && (ORG_ROLES_WITH_FULL_ACCESS as readonly OrgRole[]).includes(orgRole);
}
