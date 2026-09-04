// SPDX-License-Identifier: Apache-2.0

/**
 * The invite form's space-assignment rules, kept out of the page so they are
 * plain functions: one maps the form's draft rows to the wire shape, the other
 * is the cross-field rule between the org role and those rows.
 *
 * The rule exists as a react-hook-form `Controller` `validate` rule rather than
 * a check inside the submit handler. That shape is the fix for a real bug: the
 * check used to report through `setError("assignments", …)` on a name RHF had
 * never registered, and such an error is cleared by nothing — the form
 * validated clean, `handleSubmit` still saw a non-empty `errors`, and every
 * later submit was silently dropped until a page reload.
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
 * `true` when the (role, assignments) pair is acceptable, the message to show
 * otherwise.
 *
 * Only `guest` is constrained: it has no implicit access anywhere, so the API
 * refuses an empty list (400). `admin` may hold none and its list is dropped at
 * submit; `member` falls back to the org's open spaces.
 */
export function validateSpaceAssignments(
  role: AssignableOrgRole,
  drafts: AssignmentDraft[],
  message: string,
): true | string {
  if (role !== "guest") return true;
  return toSpaceAssignments(drafts).length > 0 ? true : message;
}
