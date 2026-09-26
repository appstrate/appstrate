// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { spacePackagePermission } from "@appstrate/core/permissions";

/** One row of `GET /api/spaces`, narrowed to what the verdict below reads. */
export interface SpaceGrant {
  permissions: string[];
  personal: boolean;
  access: "member" | "none";
}

/**
 * May this caller flip a package's activation in THIS space?
 *
 * ONE rule, in one place, because the server has one: the type's activation
 * grant in the TARGET space, or owning that space. The second half is the
 * personal-space exemption of RBAC spec §3.6 — `gateSpacePackageWrite` skips
 * the activate/deactivate grants when the space belongs to the caller, because
 * a guest holds `operator` there and `operator` carries no `agents:configure`.
 * Without it the SPA hid a control the route would have accepted.
 *
 * A personal space is reached by its owner alone (`resolveSpaceRole`), so
 * `personal && access === "member"` IS "this one is mine": the owner's id is
 * deliberately absent from the wire, and this is the fact that stands in for it.
 *
 * `undefined` — the space list has not resolved — answers `false`: the control
 * is dead while the caller's standing is unknown, and blames nobody for it.
 */
export function maySetPackageActive(
  space: SpaceGrant | undefined,
  type: PackageType,
  next: boolean,
): boolean {
  if (!space) return false;
  if (space.personal && space.access === "member") return true;
  return space.permissions.includes(spacePackagePermission(type, next ? "activate" : "deactivate"));
}

/**
 * May this caller change how THIS space runs a placed package — the PATCH's
 * `configure` gate (for a skill, `skills:write` in the space)?
 *
 * Unlike activation there is no personal-space exemption: the server's coarse
 * gate waives the grant for the owner on `activate`/`deactivate` only, so the
 * owner of a personal space answers by their grants like anyone else.
 */
export function mayConfigurePackage(space: SpaceGrant | undefined, type: PackageType): boolean {
  return !!space && space.permissions.includes(spacePackagePermission(type, "configure"));
}

/**
 * What co-authoring a package means for the caller, given their standing in its
 * HOME space (#1440).
 *
 * Sharing a package is DISTRIBUTION — the recipient gets it placed in their own
 * space and runs it with their own credentials. Working on the live object is a
 * different act entirely: a role in the space the package lives in. This is the
 * verdict that says which of the three answers that act has here, and the tab
 * renders all three rather than hiding itself, because the missing gesture was
 * the bug.
 *
 * `"personal"` comes FIRST and is not a permission question: a personal space
 * belongs to one member and takes no others (`personal_space_has_no_members`),
 * and it is never converted while it lives (`personal_space_not_orphaned`). The
 * way out is to move the PACKAGE (`PUT …/home`, which allows exactly this
 * direction) — never to open the space. So no grant, however wide, turns this
 * answer into `"invite"`, org owners and admins included: `resolveSpaceRole`
 * gives them no role there at all.
 *
 * `undefined` — the space list has not resolved, or there is no home the caller
 * reaches — answers `"unknown"`: "not yet", never a refusal.
 */
export type CoeditVerdict = "unknown" | "personal" | "no_authority" | "invite";

export function coeditVerdict(home: SpaceGrant | undefined): CoeditVerdict {
  if (!home) return "unknown";
  if (home.personal) return "personal";
  return home.permissions.includes("space-members:invite") ? "invite" : "no_authority";
}
