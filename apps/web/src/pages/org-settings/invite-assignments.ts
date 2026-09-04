// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form's space-assignment rules, kept out of the page so they are
 * plain functions: one maps the form's draft rows to the wire shape, the other
 * two are the cross-field rules between the org role and those rows.
 *
 * The validity rule is a react-hook-form `Controller` `validate` rule, so RHF
 * owns the error lifecycle; an error set on an unregistered field name is never
 * cleared.
 */

import { spaceRoleAssignment } from "../../hooks/use-roles";
import type { components } from "../../api/client";
import type { AssignableOrgRole } from "@appstrate/shared-types";

type SpaceAssignment = components["schemas"]["SpaceAssignment"];

/** One row of the invite form's space section, before it becomes wire shape. */
export interface AssignmentDraft {
  space_id: string;
  /** Encoded role option — see `spaceRoleAssignment`. */
  role: string;
}

/** Draft rows → `space_assignments`, dropping rows the user has not finished. */
export function toSpaceAssignments(drafts: AssignmentDraft[]): SpaceAssignment[] {
  return drafts
    .filter((d) => d.space_id && d.role)
    .map((d) => ({ space_id: d.space_id, ...spaceRoleAssignment(d.role) }));
}

/**
 * The list to send for `role`. `admin` already runs every space, so the API
 * refuses a non-empty list for it (400) and the rows the user picked are
 * dropped; every other role keeps what it was given.
 */
export function assignmentsFor(
  role: AssignableOrgRole,
  assignments: SpaceAssignment[],
): SpaceAssignment[] {
  return role === "admin" ? [] : assignments;
}

/**
 * `true` when the (role, assignments) pair is acceptable, the message to show
 * otherwise.
 *
 * Only `guest` is constrained: it has no implicit access anywhere, so the API
 * refuses an empty list (400). `admin` holds none by rule; `member` falls back
 * to the org's open spaces.
 */
export function validateSpaceAssignments(
  role: AssignableOrgRole,
  assignments: SpaceAssignment[],
  message: string,
): true | string {
  if (role !== "guest") return true;
  return assignments.length > 0 ? true : message;
}
