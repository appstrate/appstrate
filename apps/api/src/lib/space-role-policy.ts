// SPDX-License-Identifier: Apache-2.0

import { forbidden } from "./errors.ts";
import { spacePermissions, type SpaceRoleRef } from "./space-role.ts";

/** Every direct or implicit space-role grant stays within the caller's credential ceiling. */
export function assertCanGrantSpaceRole(
  actorPermissions: ReadonlySet<string> | undefined,
  role: SpaceRoleRef | null,
): void {
  for (const permission of spacePermissions(role)) {
    if (!actorPermissions?.has(permission)) {
      throw forbidden(`Cannot grant space permission '${permission}' that you do not hold`);
    }
  }
}
