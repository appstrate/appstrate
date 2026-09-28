// SPDX-License-Identifier: Apache-2.0

/**
 * Space-assignment form rules as plain functions. The validity rule feeds a
 * react-hook-form `Controller` `validate`, so RHF owns the error lifecycle.
 */

import { spaceRoleAssignment } from "../hooks/use-roles";
import type { components } from "../api/client";
import type { AssignableOrgRole } from "@appstrate/shared-types";

type SpaceAssignment = components["schemas"]["SpaceAssignment"];

export interface AssignmentDraft {
  spaceId: string;
  role: string;
}

export function toSpaceAssignments(drafts: AssignmentDraft[]): SpaceAssignment[] {
  return drafts
    .filter((d) => d.spaceId && d.role)
    .map((d) => ({ spaceId: d.spaceId, ...spaceRoleAssignment(d.role) }));
}

/** `admin` already runs every space: the API refuses a non-empty list for it (400). */
export function assignmentsFor(
  role: AssignableOrgRole,
  assignments: SpaceAssignment[],
): SpaceAssignment[] {
  return role === "admin" ? [] : assignments;
}

/** A loaded catalog must still contain each selection; never silently drop stale rows. */
export function hasUnavailableAssignments(
  drafts: AssignmentDraft[],
  spaces: { id: string }[],
  roles: { value: string }[],
): boolean {
  return drafts.some(
    (draft) =>
      !spaces.some((space) => space.id === draft.spaceId) ||
      !roles.some((role) => role.value === draft.role),
  );
}
