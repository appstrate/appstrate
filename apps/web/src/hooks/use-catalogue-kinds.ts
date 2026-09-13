// SPDX-License-Identifier: Apache-2.0

/**
 * Which kinds of package this caller may activate in the current space.
 *
 * The navigation entry, the route and the panel's rail all ask this same
 * question, and an entry that opens a panel with an empty rail is worse than no
 * entry at all.
 */
import type { PackageType } from "@appstrate/core/validation";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
import { usePermissions } from "./use-permissions";

const CATALOGUE_KINDS: PackageType[] = ["agent", "skill", "mcp-server", "integration"];

export function useCatalogueKinds(): PackageType[] {
  const { can } = usePermissions();
  return CATALOGUE_KINDS.filter((type) => can(PACKAGE_PERMISSIONS[type].install));
}
