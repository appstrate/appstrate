// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { spacePackagePermission } from "@appstrate/core/permissions";

export interface SpaceGrant {
  permissions: string[];
  personal: boolean;
  access: "member" | "none";
}

/**
 * May this caller flip an activation of this TYPE in THIS space, with no package in
 * hand (anything holding a package row reads the served `activation` verdict instead)?
 * Mirrors the server: the activation grant, or owning the space (RBAC spec §3.6,
 * `gateSpacePackageWrite`). A personal space is reached by its owner alone, so
 * `personal && access === "member"` IS "mine" (the owner's id is absent from the wire).
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
 * May this caller change how THIS space runs a placed package (the PATCH's
 * `configure` gate)? No personal-space exemption: the server waives the grant for
 * the owner on `activate`/`deactivate` only.
 */
export function mayConfigurePackage(space: SpaceGrant | undefined, type: PackageType): boolean {
  return !!space && space.permissions.includes(spacePackagePermission(type, "configure"));
}
