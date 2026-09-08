// SPDX-License-Identifier: Apache-2.0

import { forbidden } from "./errors.ts";
import { spacePermissions, type SpaceRoleRef } from "./space-role.ts";

function missingPermission(
  actorPermissions: ReadonlySet<string> | undefined,
  permissions: Iterable<string>,
): string | undefined {
  for (const permission of permissions) {
    if (!actorPermissions?.has(permission)) return permission;
  }
  return undefined;
}

/** The assignable catalog uses the same credential ceiling as role writes. */
export function canGrantSpaceRole(
  actorPermissions: ReadonlySet<string> | undefined,
  role: SpaceRoleRef | null,
): boolean {
  return missingPermission(actorPermissions, spacePermissions(role)) === undefined;
}

/** Every direct or implicit space-role grant stays within the caller's credential ceiling. */
export function assertCanGrantSpaceRole(
  actorPermissions: ReadonlySet<string> | undefined,
  role: SpaceRoleRef | null,
): void {
  const permission = missingPermission(actorPermissions, spacePermissions(role));
  if (permission !== undefined) {
    throw forbidden(`Cannot grant space permission '${permission}' that you do not hold`);
  }
}
