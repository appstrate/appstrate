// SPDX-License-Identifier: Apache-2.0

/**
 * Role-assignment helpers over core's `spaceRoleReferenceSchema` (exactly one of `preset_role` /
 * `custom_role_id`): routes intersect it with what sits beside the role.
 */

import { z } from "zod";
import { spaceRoleReferenceSchema } from "@appstrate/core/permissions";
import type { SpaceAssignment, SpaceRolePreset } from "@appstrate/core/permissions";
import type { SpaceRoleAssignment } from "@appstrate/shared-types";
import { isSpaceId } from "./ids.ts";

export function toAssignment(data: {
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}): SpaceRoleAssignment {
  return data.preset_role !== undefined
    ? { preset_role: data.preset_role }
    : { custom_role_id: data.custom_role_id! };
}

export const spaceAssignmentSchema = z.intersection(
  z
    .object({
      // Reject a malformed ID before looking up its space.
      spaceId: z.string().refine(isSpaceId, {
        message: "Malformed space id. Expected `spc_` followed by a canonical UUID.",
      }),
    })
    .strict(),
  spaceRoleReferenceSchema,
);

/** A `space_members` row's role columns, one set; how audits name a role (CASING_CONVENTIONS 4m). */
export type SpaceRoleColumns = {
  presetRole: SpaceRolePreset | null;
  customRoleId: string | null;
};

export function auditSpaceRole(data: {
  preset_role?: SpaceRolePreset | null;
  custom_role_id?: string | null;
}): SpaceRoleColumns {
  return { presetRole: data.preset_role ?? null, customRoleId: data.custom_role_id ?? null };
}

export function auditSpaceAssignments(assignments: ReadonlyArray<SpaceAssignment>) {
  return assignments.map((a) => ({ spaceId: a.spaceId, ...auditSpaceRole(a) }));
}
