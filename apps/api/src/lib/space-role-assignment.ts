// SPDX-License-Identifier: Apache-2.0

/**
 * The "exactly one role reference" body shape, in one place.
 *
 * Three routes accept it — `POST` and `PATCH /api/spaces/:id/members`, and the
 * `space_assignments[]` an invitation carries — and they differ only in what
 * they put BESIDE the role: a `userId`, nothing, or a `space_id`. The xor rule
 * and its error message are the part that must not drift, because a client
 * reads the same message from all three and the service
 * (`assignmentColumns`) assumes the rule already held.
 */

import { z } from "zod";
import { SPACE_ROLE_PRESETS } from "@appstrate/core/permissions";
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import type { SpaceRoleAssignment } from "../services/space-members.ts";

/**
 * Zod's `.refine()` returns a wrapper that cannot be `.extend()`ed, so the
 * shared piece is the SHAPE plus the rule, applied by {@link exactlyOneRole}
 * after each caller has added its own fields.
 */
export const spaceRoleAssignmentShape = {
  preset_role: z.enum(SPACE_ROLE_PRESETS).optional(),
  custom_role_id: z.string().min(1).optional(),
};

/** Apply the xor rule to a schema that already carries the shape above. */
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

/** Narrow a validated body to the union the service takes. */
export function toAssignment(data: {
  preset_role?: SpaceRolePreset;
  custom_role_id?: string;
}): SpaceRoleAssignment {
  return data.preset_role !== undefined
    ? { preset_role: data.preset_role }
    : { custom_role_id: data.custom_role_id! };
}
