// SPDX-License-Identifier: Apache-2.0

/**
 * The "exactly one role reference" body shape, in one place: three routes differ only in what
 * sits beside the role, and `assignmentColumns` assumes the xor rule and its message held.
 */

import { z } from "zod";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import type { SpaceRoleAssignment } from "../services/space-members.ts";
import { isSpaceId, isSpaceRoleId } from "./ids.ts";

/** `.refine()` returns a wrapper nothing can `.extend()`, so shape and rule ship apart. */
export const spaceRoleAssignmentShape = {
  preset_role: z.enum(SPACE_ROLE_PRESETS).optional(),
  custom_role_id: z
    .string()
    .refine(isSpaceRoleId, {
      message: "Malformed space role id. Expected `srl_` followed by a canonical UUID.",
    })
    .optional(),
};

export function exactlyOneRole<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  return schema.strict().refine(
    (v) => {
      const { preset_role, custom_role_id } = v as {
        preset_role?: unknown;
        custom_role_id?: unknown;
      };
      return (preset_role === undefined) !== (custom_role_id === undefined);
    },
    { message: "exactly one of preset_role or custom_role_id is required" },
  );
}

export function toAssignment(data: {
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}): SpaceRoleAssignment {
  return data.preset_role !== undefined
    ? { preset_role: data.preset_role }
    : { custom_role_id: data.custom_role_id! };
}

export const spaceAssignmentSchema = exactlyOneRole(
  z.object({
    // Shape-checked like the `custom_role_id` beside it: a retired `app_` id
    // resolves to no space, and without this it reports that as "space not
    // found" — the same silence `SPACE_ID_RE` exists to end.
    space_id: z.string().refine(isSpaceId, {
      message: "Malformed space id. Expected `spc_` followed by a canonical UUID.",
    }),
    ...spaceRoleAssignmentShape,
  }),
);
