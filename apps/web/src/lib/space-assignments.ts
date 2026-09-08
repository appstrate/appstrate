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
  space_id: string;
  role: string;
}

export function toSpaceAssignments(drafts: AssignmentDraft[]): SpaceAssignment[] {
  return drafts
    .filter((d) => d.space_id && d.role)
    .map((d) => ({ space_id: d.space_id, ...spaceRoleAssignment(d.role) }));
}

/** `admin` already runs every space: the API refuses a non-empty list for it (400). */
export function assignmentsFor(
  role: AssignableOrgRole,
  assignments: SpaceAssignment[],
): SpaceAssignment[] {
  return role === "admin" ? [] : assignments;
}

/**
 * Only `guest` is constrained: it has no implicit access anywhere, so the API
 * refuses an empty list (400). `member` falls back to the org's open spaces.
 */
export function validateSpaceAssignments(
  role: AssignableOrgRole,
  assignments: SpaceAssignment[],
  message: string,
): true | string {
  if (role !== "guest") return true;
  return assignments.length > 0 ? true : message;
}

/** A loaded catalog must still contain each selection; never silently drop stale rows. */
export function hasUnavailableAssignments(
  drafts: AssignmentDraft[],
  spaces: { id: string }[],
  roles: { value: string }[],
): boolean {
  return drafts.some(
    (draft) =>
      !spaces.some((space) => space.id === draft.space_id) ||
      !roles.some((role) => role.value === draft.role),
  );
}
