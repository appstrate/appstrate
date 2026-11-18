// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import { spacePackagePermission } from "@appstrate/core/permissions";
import { isOwnPersonalSpace } from "./own-personal-space";

export interface SpaceGrant {
  permissions: string[];
  personal: boolean;
  access: "member" | "none";
}

/**
 * May this caller flip an activation of this TYPE in THIS space, with no package in
 * hand (anything holding a package row reads the served `activation` verdict instead)?
 * Mirrors the server: the activation grant, or owning the space (RBAC spec §3.6,
 * `gateSpacePackageWrite`). A personal space is reached by its owner alone, so owning
 * the space (`isOwnPersonalSpace`) is simply being its caller.
 */
export function maySetPackageActive(
  space: SpaceGrant | undefined,
  type: PackageType,
  next: boolean,
): boolean {
  if (!space) return false;
  if (isOwnPersonalSpace(space)) return true;
  return space.permissions.includes(spacePackagePermission(type, next ? "activate" : "deactivate"));
}
