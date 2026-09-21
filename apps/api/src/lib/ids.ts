// SPDX-License-Identifier: Apache-2.0

/**
 * The id-shape ASSERTIONS — the half that needs `invalidRequest`, and therefore
 * cannot live next to the minting itself. `prefixedId` and `SPACE_ID_RE` are in
 * `@appstrate/db/ids`, where `provision-org.ts` can reach them too.
 */

import { SPACE_ID_RE } from "@appstrate/db/ids";
import { invalidRequest } from "./errors.ts";

/** Whether `id` is a canonical space id — the Zod-side half of {@link assertSpaceId}. */
export function isSpaceId(id: string): boolean {
  return SPACE_ID_RE.test(id);
}

/**
 * Throw unless `id` is a canonical space id. `param` names the field the id
 * arrived on so the 400 points at it (`X-Space-Id`, `space_id`, …).
 */
export function assertSpaceId(id: string, param = "space_id"): void {
  if (isSpaceId(id)) return;
  throw invalidRequest(
    `Malformed space id '${id}'. Expected \`spc_\` followed by a canonical UUID.`,
    param,
  );
}

/**
 * Strict custom-space-role id shape: `srl_` + a canonical lowercase dashed
 * UUID — exactly what `prefixedId("srl")` mints.
 *
 * Same reasoning as `SPACE_ID_RE` (`@appstrate/db/ids`): a role id arrives on a
 * path param (`/api/roles/:id`) and in a `space_members.custom_role_id` write,
 * and both would otherwise answer 404 for a malformed id, saying nothing about WHY.
 */
const SPACE_ROLE_ID_RE = /^srl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Whether `id` is a canonical space-role id. The predicate half of
 * {@link assertSpaceRoleId}, for the body field that is validated by Zod
 * (`spaceRoleAssignmentShape.custom_role_id`) rather than by a throw.
 */
export function isSpaceRoleId(id: string): boolean {
  return SPACE_ROLE_ID_RE.test(id);
}

/**
 * Throw unless `id` is a canonical space-role id. `param` names the field the
 * id arrived on so the 400 points at it (`id`, `custom_role_id`, …).
 */
export function assertSpaceRoleId(id: string, param = "id"): void {
  if (isSpaceRoleId(id)) return;
  throw invalidRequest(
    `Malformed space role id '${id}'. Expected \`srl_\` followed by a canonical UUID.`,
    param,
  );
}
